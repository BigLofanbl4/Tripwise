const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();
console.log('[dotenv] OPENWEATHER_API_KEY after load:', process.env.OPENWEATHER_API_KEY ? `${process.env.OPENWEATHER_API_KEY.slice(0,4)}...${process.env.OPENWEATHER_API_KEY.slice(-4)}` : 'undefined');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const db = require('./database');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;
const SECRET_KEY = 'super_secret_key_change_me';

app.use(bodyParser.json());
app.use(express.static('public')); // Раздача фронтенда

const httpsGetJson = (url) => {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Tripwise/1.0' } }, (resp) => {
            let data = '';
            resp.on('data', (chunk) => (data += chunk));
            resp.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (resp.statusCode >= 400) {
                        return reject(new Error(json && json.message ? json.message : `HTTP ${resp.statusCode}`));
                    }
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
};

// --- Middleware для проверки токена ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
    if (!token) return res.sendStatus(401);

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        db.get(`SELECT COALESCE(is_banned, 0) as is_banned FROM users WHERE id = ?`, [user.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.sendStatus(403);
            if (row.is_banned) return res.status(403).json({ error: 'User is banned' });
            req.user = user;
            next();
        });
    });
};

const requireAdmin = (req, res, next) => {
    db.get(`SELECT is_admin FROM users WHERE id = ?`, [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !row.is_admin) return res.status(403).json({ error: 'Admin only' });
        next();
    });
};

// --- API: Аутентификация ---

// Регистрация
app.post('/api/register', (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    const hashedPassword = bcrypt.hashSync(password, 8);
    
    db.run(`INSERT INTO users (email, password, name, created_at) VALUES (?, ?, ?, datetime('now'))`, 
        [email, hashedPassword, name], 
        function(err) {
            if (err) {
                console.error('Register error:', err.message);
                if (String(err.message || '').toLowerCase().includes('unique')) {
                    return res.status(409).json({ error: "Email already exists" });
                }
                return res.status(500).json({ error: err.message });
            }

            const newUserId = this.lastID;

            db.get(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`, (err, row) => {
                if (err) {
                    console.error('Register admin bootstrap error:', err.message);
                }
                const hasAnyAdmin = row && row.cnt > 0;
                if (!hasAnyAdmin) {
                    db.run(`UPDATE users SET is_admin = 1 WHERE id = ?`, [newUserId]);
                }
                const token = jwt.sign({ id: newUserId, email }, SECRET_KEY);
                res.json({ token, user: { id: newUserId, name, email } });
            });
        }
    );
});

// Вход
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) {
            console.error('Login error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (user && user.is_banned) {
            return res.status(403).json({ error: 'User is banned' });
        }
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        db.get(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`, (err, row) => {
            if (err) {
                console.error('Login admin bootstrap error:', err.message);
            }
            const hasAnyAdmin = row && row.cnt > 0;
            if (!hasAnyAdmin) {
                db.run(`UPDATE users SET is_admin = 1 WHERE id = ?`, [user.id]);
            }
            const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY);
            res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
        });
    });
});

app.get('/api/me', authenticateToken, (req, res) => {
    db.get(`SELECT id, name, email, COALESCE(is_admin, 0) as is_admin, COALESCE(is_banned, 0) as is_banned, created_at FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    });
});

app.get('/api/motd', authenticateToken, (req, res) => {
    db.get(`SELECT value FROM app_settings WHERE key = 'motd'`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: (row && row.value) ? row.value : '' });
    });
});

// --- API: Админ панель ---

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT id, name, email, COALESCE(is_admin, 0) as is_admin, COALESCE(is_banned, 0) as is_banned, created_at FROM users ORDER BY id`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.patch('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const targetUserId = Number(req.params.id);
    const patch = req.body || {};
    const hasIsAdmin = Object.prototype.hasOwnProperty.call(patch, 'is_admin');
    const hasIsBanned = Object.prototype.hasOwnProperty.call(patch, 'is_banned');
    const isAdmin = hasIsAdmin ? (patch.is_admin ? 1 : 0) : null;
    const isBanned = hasIsBanned ? (patch.is_banned ? 1 : 0) : null;
    if (!targetUserId) return res.status(400).json({ error: 'Invalid user id' });

    if (targetUserId === req.user.id && isBanned === 1) {
        return res.status(400).json({ error: 'Cannot ban yourself' });
    }

    const applyUpdate = () => {
        const set = [];
        const values = [];
        if (isAdmin !== null) {
            set.push('is_admin = ?');
            values.push(isAdmin);
        }
        if (isBanned !== null) {
            set.push('is_banned = ?');
            values.push(isBanned);
        }
        if (!set.length) return res.status(400).json({ error: 'Nothing to update' });

        values.push(targetUserId);
        db.run(`UPDATE users SET ${set.join(', ')} WHERE id = ?`, values, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Updated' });
        });
    };

    if (isAdmin === 0) {
        db.get(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`, (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if ((row && row.cnt) <= 1) {
                return res.status(400).json({ error: 'Cannot remove the last admin' });
            }
            applyUpdate();
        });
        return;
    }

    applyUpdate();
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) return res.status(400).json({ error: 'Invalid user id' });
    if (targetUserId === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

    db.get(`SELECT COALESCE(is_admin, 0) as is_admin FROM users WHERE id = ?`, [targetUserId], (err, target) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!target) return res.status(404).json({ error: 'User not found' });

        const doDelete = () => {
            db.run(`DELETE FROM trips WHERE user_id = ?`, [targetUserId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run(`DELETE FROM users WHERE id = ?`, [targetUserId], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ message: 'Deleted' });
                });
            });
        };

        if (target.is_admin) {
            db.get(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`, (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if ((row && row.cnt) <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
                doDelete();
            });
            return;
        }

        doDelete();
    });
});

app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
    db.get(`SELECT COUNT(*) as total_users FROM users`, (err, u) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT COUNT(*) as total_trips, COALESCE(SUM(budget), 0) as sum_budgets FROM trips`, (err, t) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get(`SELECT COUNT(*) as total_items FROM trip_items`, (err, i) => {
                if (err) return res.status(500).json({ error: err.message });
                db.get(`SELECT COUNT(*) as trips_last_7_days FROM trips WHERE created_at >= datetime('now', '-7 days')`, (err, a) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        total_users: u.total_users,
                        total_trips: t.total_trips,
                        total_items: i.total_items,
                        sum_budgets: t.sum_budgets,
                        trips_last_7_days: a.trips_last_7_days
                    });
                });
            });
        });
    });
});

app.get('/api/admin/trips', authenticateToken, requireAdmin, (req, res) => {
    db.all(
        `SELECT tr.id, tr.title, tr.start_date, tr.end_date, tr.budget, tr.created_at, tr.user_id, u.email as user_email
         FROM trips tr
         JOIN users u ON tr.user_id = u.id
         ORDER BY tr.id DESC`,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.delete('/api/admin/trips/:id', authenticateToken, requireAdmin, (req, res) => {
    const tripId = Number(req.params.id);
    if (!tripId) return res.status(400).json({ error: 'Invalid trip id' });
    db.run(`DELETE FROM trips WHERE id = ?`, [tripId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Deleted' });
    });
});

app.post('/api/admin/trips/cleanup', authenticateToken, requireAdmin, (req, res) => {
    const body = req.body || {};
    const olderThanDays = Number(body.older_than_days || 0);
    const titleContains = (body.title_contains || '').toString().trim().toLowerCase();

    const where = [];
    const params = [];
    if (olderThanDays > 0) {
        where.push(`created_at < datetime('now', ? )`);
        params.push(`-${olderThanDays} days`);
    }
    if (titleContains) {
        where.push(`LOWER(title) LIKE ?`);
        params.push(`%${titleContains}%`);
    }
    if (!where.length) return res.status(400).json({ error: 'No cleanup filter provided' });

    db.run(`DELETE FROM trips WHERE ${where.join(' AND ')}`, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

app.put('/api/admin/motd', authenticateToken, requireAdmin, (req, res) => {
    const message = (req.body && req.body.message ? String(req.body.message) : '').trim();
    db.run(
        `INSERT INTO app_settings (key, value) VALUES ('motd', ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [message],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Updated' });
        }
    );
});

app.delete('/api/admin/motd', authenticateToken, requireAdmin, (req, res) => {
    db.run(`DELETE FROM app_settings WHERE key = 'motd'`, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Deleted' });
    });
});

// --- API: Поездки ---

// Получить все поездки пользователя
app.get('/api/trips', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM trips WHERE user_id = ? ORDER BY start_date`, [req.user.id], (err, rows) => {
        res.json(rows);
    });
});

// Создать поездку
app.post('/api/trips', authenticateToken, (req, res) => {
    const { title, start_date, end_date, budget } = req.body;
    db.run(`INSERT INTO trips (user_id, title, start_date, end_date, budget, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [req.user.id, title, start_date, end_date, budget || 0],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

// Получить детали поездки и пункты
app.get('/api/trips/:id', authenticateToken, (req, res) => {
    const tripId = req.params.id;
    
    db.get(`SELECT * FROM trips WHERE id = ? AND user_id = ?`, [tripId, req.user.id], (err, trip) => {
        if (!trip) return res.status(404).json({ error: "Trip not found" });
        
        db.all(`SELECT * FROM trip_items WHERE trip_id = ? ORDER BY day_number, time`, [tripId], (err, items) => {
            res.json({ ...trip, items });
        });
    });
});

app.get('/api/trips/:id/weather', authenticateToken, (req, res) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    console.log('[weather] OPENWEATHER_API_KEY loaded:', apiKey ? `${apiKey.slice(0,4)}...${apiKey.slice(-4)}` : 'undefined');
    if (!apiKey) return res.status(500).json({ error: 'OPENWEATHER_API_KEY is not set' });

    const tripId = req.params.id;
    db.get(`SELECT title, start_date, end_date FROM trips WHERE id = ? AND user_id = ?`, [tripId, req.user.id], async (err, trip) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!trip) return res.status(404).json({ error: 'Trip not found' });

        const raw = String(trip.title || '').trim();
        const cityBase = raw.split(/[-,()]/)[0].trim();
        const city = (cityBase.replace(/[^\p{L}\p{N}\s\-']/gu, '').trim()) || cityBase;
        if (!city) return res.status(400).json({ error: 'City not found in trip title' });

        try {
            const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${encodeURIComponent(apiKey)}`;
            console.log('[weather] geoUrl:', geoUrl);
            const geo = await httpsGetJson(geoUrl);
            if (!Array.isArray(geo) || !geo.length) {
                return res.status(404).json({ error: 'City not found' });
            }
            const { lat, lon, name, country } = geo[0];

            const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&units=metric&lang=ru&appid=${encodeURIComponent(apiKey)}`;
            const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&units=metric&lang=ru&appid=${encodeURIComponent(apiKey)}`;

            const [current, forecast] = await Promise.all([
                httpsGetJson(currentUrl),
                httpsGetJson(forecastUrl)
            ]);

            const startDate = trip.start_date ? String(trip.start_date) : null;
            const endDate = trip.end_date ? String(trip.end_date) : startDate;

            const byDay = new Map();
            const list = (forecast && Array.isArray(forecast.list)) ? forecast.list : [];
            for (const it of list) {
                const dtTxt = it && it.dt_txt ? String(it.dt_txt) : '';
                const day = dtTxt.slice(0, 10);
                if (!day) continue;
                if (startDate && day < startDate) continue;
                if (endDate && day > endDate) continue;

                const main = it && it.main ? it.main : {};
                const weather0 = it && Array.isArray(it.weather) && it.weather[0] ? it.weather[0] : {};
                const temp = typeof main.temp === 'number' ? main.temp : null;
                if (temp === null) continue;

                if (!byDay.has(day)) byDay.set(day, { temps: [], descriptions: {}, icons: {} });
                const bucket = byDay.get(day);
                bucket.temps.push(temp);

                const desc = weather0.description ? String(weather0.description) : '';
                const icon = weather0.icon ? String(weather0.icon) : '';
                if (desc) bucket.descriptions[desc] = (bucket.descriptions[desc] || 0) + 1;
                if (icon) bucket.icons[icon] = (bucket.icons[icon] || 0) + 1;
            }

            const pickMostFrequent = (obj) => {
                let bestKey = '';
                let bestVal = -1;
                for (const [k, v] of Object.entries(obj || {})) {
                    if (v > bestVal) {
                        bestVal = v;
                        bestKey = k;
                    }
                }
                return bestKey;
            };

            const forecastDays = Array.from(byDay.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, bucket]) => {
                    const temps = bucket.temps || [];
                    const min = temps.length ? Math.min(...temps) : null;
                    const max = temps.length ? Math.max(...temps) : null;
                    return {
                        date,
                        temp_min: min !== null ? Math.round(min) : null,
                        temp_max: max !== null ? Math.round(max) : null,
                        description: pickMostFrequent(bucket.descriptions),
                        icon: pickMostFrequent(bucket.icons)
                    };
                });

            const currentWeather0 = current && Array.isArray(current.weather) && current.weather[0] ? current.weather[0] : {};
            res.json({
                city: `${name || city}${country ? ', ' + country : ''}`,
                current: {
                    temp: current && current.main && typeof current.main.temp === 'number' ? Math.round(current.main.temp) : null,
                    description: currentWeather0.description || '',
                    icon: currentWeather0.icon || '',
                    humidity: current && current.main ? current.main.humidity : null,
                    wind_speed: current && current.wind ? current.wind.speed : null
                },
                forecast_days: forecastDays
            });
        } catch (e) {
            console.error('[weather] OpenWeatherMap error:', e);
            return res.status(500).json({ error: e.message || 'Weather service error' });
        }
    });
});

// Удалить поездку
app.delete('/api/trips/:id', authenticateToken, (req, res) => {
    db.run(`DELETE FROM trips WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id], function(err) {
        res.json({ message: "Deleted" });
    });
});

// --- API: Пункты маршрута ---

// Добавить пункт
app.post('/api/trips/:id/items', authenticateToken, (req, res) => {
    const { day_number, title, time, notes, cost, category } = req.body;
    db.run(`INSERT INTO trip_items (trip_id, day_number, title, time, notes, cost, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.params.id, day_number, title, time, notes, cost || 0, category || 'Другое'],
        function(err) {
            res.json({ id: this.lastID });
        }
    );
});

// Удалить пункт
app.delete('/api/items/:id', authenticateToken, (req, res) => {
    // В реальном приложении нужно проверить права доступа к trip_id
    db.run(`DELETE FROM trip_items WHERE id = ?`, [req.params.id], function(err) {
        res.json({ message: "Item deleted" });
    });
});

// --- API: Чек-лист вещей ---

// Получить packing items для поездки
app.get('/api/trips/:id/packing', authenticateToken, (req, res) => {
    const tripId = req.params.id;
    
    // Проверяем, что поездка принадлежит пользователю
    db.get(`SELECT id FROM trips WHERE id = ? AND user_id = ?`, [tripId, req.user.id], (err, trip) => {
        if (!trip) return res.status(404).json({ error: "Trip not found" });
        
        db.all(`SELECT * FROM packing_items WHERE trip_id = ? ORDER BY id`, [tripId], (err, items) => {
            res.json(items);
        });
    });
});

// Добавить packing item
app.post('/api/trips/:id/packing', authenticateToken, (req, res) => {
    const { title } = req.body;
    const tripId = req.params.id;
    
    // Проверяем, что поездка принадлежит пользователю
    db.get(`SELECT id FROM trips WHERE id = ? AND user_id = ?`, [tripId, req.user.id], (err, trip) => {
        if (!trip) return res.status(404).json({ error: "Trip not found" });
        
        db.run(`INSERT INTO packing_items (trip_id, title) VALUES (?, ?)`,
            [tripId, title],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID });
            }
        );
    });
});

// Обновить статус packing item
app.put('/api/packing/:id', authenticateToken, (req, res) => {
    const { is_done } = req.body;
    
    // Проверяем права доступа через trip_id
    db.get(`SELECT p.trip_id FROM packing_items p JOIN trips t ON p.trip_id = t.id WHERE p.id = ? AND t.user_id = ?`, 
        [req.params.id, req.user.id], (err, result) => {
        if (!result) return res.status(404).json({ error: "Item not found" });
        
        db.run(`UPDATE packing_items SET is_done = ? WHERE id = ?`, [is_done ? 1 : 0, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated" });
        });
    });
});

// Удалить packing item
app.delete('/api/packing/:id', authenticateToken, (req, res) => {
    // Проверяем права доступа через trip_id
    db.get(`SELECT p.trip_id FROM packing_items p JOIN trips t ON p.trip_id = t.id WHERE p.id = ? AND t.user_id = ?`, 
        [req.params.id, req.user.id], (err, result) => {
        if (!result) return res.status(404).json({ error: "Item not found" });
        
        db.run(`DELETE FROM packing_items WHERE id = ?`, [req.params.id], function(err) {
            res.json({ message: "Deleted" });
        });
    });
});

// Получить статистику по категориям для поездки
app.get('/api/trips/:id/stats', authenticateToken, (req, res) => {
    const tripId = req.params.id;
    
    // Проверяем, что поездка принадлежит пользователю
    db.get(`SELECT * FROM trips WHERE id = ? AND user_id = ?`, [tripId, req.user.id], (err, trip) => {
        if (!trip) return res.status(404).json({ error: "Trip not found" });
        
        // Получаем статистику по категориям
        db.all(`SELECT COALESCE(category, 'Другое') as category, SUM(cost) as total, COUNT(*) as count 
                FROM trip_items 
                WHERE trip_id = ? AND cost > 0 
                GROUP BY category 
                ORDER BY total DESC`, 
            [tripId], (err, categoryStats) => {
            if (err) return res.status(500).json({ error: err.message });
            
            // Общая сумма расходов
            const totalSpent = categoryStats.reduce((sum, cat) => sum + cat.total, 0);
            
            // Добавляем процент от бюджета
            const statsWithPercentage = categoryStats.map(cat => ({
                ...cat,
                percentage: trip.budget > 0 ? (cat.total / trip.budget * 100).toFixed(1) : 0,
                budget_percentage: totalSpent > 0 ? (cat.total / totalSpent * 100).toFixed(1) : 0
            }));
            
            res.json({
                budget: trip.budget,
                total_spent: totalSpent,
                remaining: trip.budget - totalSpent,
                categories: statsWithPercentage
            });
        });
    });
});

// --- PDF Экспорт ---
// --- PDF Экспорт ---
app.get('/api/trips/:id/pdf', authenticateToken, (req, res) => {
    const tripId = req.params.id;
    
    // Получаем токен из заголовка ИЛИ из query-параметра (для ссылки "Скачать")
    // ВАЖНО: Это исправление нужно, чтобы ссылка работала по клику
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

    if (!token) return res.status(401).send("Unauthorized");

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);

        db.get(`SELECT * FROM trips WHERE id = ? AND user_id = ?`, [tripId, user.id], (err, trip) => {
            if (!trip) return res.status(404).send("Not found");
            
            db.all(`SELECT * FROM trip_items WHERE trip_id = ? ORDER BY day_number, time`, [tripId], (err, items) => {
                db.all(`SELECT * FROM packing_items WHERE trip_id = ? ORDER BY id`, [tripId], (err, packingItems) => {
                    const doc = new PDFDocument({ margin: 50 });

                    const fontPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
                    doc.font(fontPath);

                    res.setHeader('Content-Type', 'application/pdf');
                    const filename = encodeURIComponent(`Plan-${trip.title}.pdf`);
                    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

                    doc.pipe(res);

                    const pageWidth = doc.page.width;
                    const margin = doc.page.margins.left;
                    const contentWidth = pageWidth - doc.page.margins.left - doc.page.margins.right;

                    const ensureSpace = (needed = 40) => {
                        const bottom = doc.page.height - doc.page.margins.bottom;
                        if (doc.y + needed > bottom) doc.addPage();
                    };

                    const spent = (items || []).reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
                    const remaining = (Number(trip.budget) || 0) - spent;

                    doc.fontSize(22).fillColor('#111827').text(trip.title, { align: 'center' });
                    doc.moveDown(0.2);
                    doc.fontSize(12).fillColor('#6b7280').text(`${trip.start_date} — ${trip.end_date}`, { align: 'center' });
                    doc.moveDown(1);

                    doc.fillColor('#111827').fontSize(14).text('Сводка', { underline: true });
                    doc.moveDown(0.5);
                    doc.fontSize(12).fillColor('#111827');
                    doc.text(`Бюджет: ${trip.budget || 0} ₽`);
                    doc.text(`Потрачено: ${spent} ₽`);
                    doc.fillColor(remaining < 0 ? '#b91c1c' : '#065f46').text(`Осталось: ${remaining} ₽`);
                    doc.fillColor('#111827');

                    doc.moveDown(0.8);
                    doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y).strokeColor('#e5e7eb').stroke();
                    doc.strokeColor('#000000');
                    doc.moveDown(0.8);

                    doc.fontSize(14).fillColor('#111827').text('Маршрут', { underline: true });
                    doc.moveDown(0.5);

                    if (!items || items.length === 0) {
                        doc.fontSize(12).fillColor('#6b7280').text('Маршрут пуст.');
                        doc.fillColor('#111827');
                    } else {
                        let currentDay = null;
                        items.forEach((item) => {
                            if (item.day_number !== currentDay) {
                                currentDay = item.day_number;
                                ensureSpace(60);
                                doc.moveDown(0.6);
                                doc.x = margin;
                                doc.fontSize(16).fillColor('#111827').text(`День ${currentDay}`, margin, doc.y, { width: contentWidth });
                                doc.moveDown(0.3);
                            }

                            ensureSpace(45);
                            const time = item.time ? String(item.time) : '';
                            const title = item.title ? String(item.title) : '';
                            const category = item.category ? String(item.category) : 'Другое';
                            const cost = Number(item.cost) || 0;

                            const left = `${time ? time + ' — ' : ''}${title}`;
                            doc.fontSize(12).fillColor('#111827').text(left, margin, doc.y, { width: contentWidth - 120 });
                            doc.fontSize(12).fillColor('#6b7280').text(category, margin, doc.y, { width: contentWidth - 120 });
                            doc.fontSize(12).fillColor('#111827').text(`${cost} ₽`, margin + contentWidth - 110, doc.y - 24, { width: 110, align: 'right' });
                            doc.x = margin;

                            if (item.notes) {
                                ensureSpace(25);
                                doc.fontSize(10).fillColor('#6b7280').text(String(item.notes), { width: contentWidth });
                            }
                            doc.fillColor('#111827');
                            doc.moveDown(0.5);
                        });
                    }

                    ensureSpace(80);
                    doc.moveDown(0.6);
                    doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y).strokeColor('#e5e7eb').stroke();
                    doc.strokeColor('#000000');
                    doc.moveDown(0.8);

                    doc.fontSize(14).fillColor('#111827').text('Что взять с собой', { underline: true });
                    doc.moveDown(0.5);

                    if (!packingItems || packingItems.length === 0) {
                        doc.fontSize(12).fillColor('#6b7280').text('Список пуст.');
                        doc.fillColor('#111827');
                    } else {
                        packingItems.forEach((pi) => {
                            ensureSpace(25);
                            const mark = pi.is_done ? '[x]' : '[ ]';
                            doc.fontSize(12).fillColor('#111827').text(`${mark} ${pi.title}`);
                        });
                    }

                    doc.end();
                });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});