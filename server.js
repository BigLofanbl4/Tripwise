const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const db = require('./database');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET_KEY = 'super_secret_key_change_me';

app.use(bodyParser.json());
app.use(express.static('public')); // Раздача фронтенда

// --- Middleware для проверки токена ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
    if (!token) return res.sendStatus(401);

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
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
    
    db.run(`INSERT INTO users (email, password, name) VALUES (?, ?, ?)`, 
        [email, hashedPassword, name], 
        function(err) {
            if (err) {
                console.error('Register error:', err.message);
                if (String(err.message || '').toLowerCase().includes('unique')) {
                    return res.status(409).json({ error: "Email already exists" });
                }
                return res.status(500).json({ error: err.message });
            }
            const token = jwt.sign({ id: this.lastID, email }, SECRET_KEY);
            res.json({ token, user: { id: this.lastID, name, email } });
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
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY);
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
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
    db.run(`INSERT INTO trips (user_id, title, start_date, end_date, budget) VALUES (?, ?, ?, ?, ?)`,
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