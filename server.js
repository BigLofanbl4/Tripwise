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
    const hashedPassword = bcrypt.hashSync(password, 8);
    
    db.run(`INSERT INTO users (email, password, name) VALUES (?, ?, ?)`, 
        [email, hashedPassword, name], 
        function(err) {
            if (err) return res.status(500).json({ error: "Email already exists" });
            const token = jwt.sign({ id: this.lastID, email }, SECRET_KEY);
            res.json({ token, user: { id: this.lastID, name, email } });
        }
    );
});

// Вход
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
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
    const { day_number, title, time, notes, cost } = req.body;
    db.run(`INSERT INTO trip_items (trip_id, day_number, title, time, notes, cost) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.params.id, day_number, title, time, notes, cost || 0],
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
                const doc = new PDFDocument();
                
                // === ВАЖНО: ПОДКЛЮЧЕНИЕ ШРИФТА ===
                // Указываем путь к файлу шрифта
                const fontPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
                doc.font(fontPath); 
                // =================================

                res.setHeader('Content-Type', 'application/pdf');
                // Кодируем имя файла, чтобы русское название не ломало заголовок
                const filename = encodeURIComponent(`Plan-${trip.title}.pdf`);
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                
                doc.pipe(res);

                // Заголовок PDF
                doc.fontSize(20).text(trip.title, { align: 'center' });
                doc.fontSize(12).text(`${trip.start_date} — ${trip.end_date}`, { align: 'center' });
                doc.moveDown();
                doc.text(`Бюджет: ${trip.budget} руб.`);
                doc.moveDown();
                
                // Рисуем линию
                doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
                doc.moveDown();

                // Группировка по дням
                let currentDay = 0;
                items.forEach(item => {
                    if (item.day_number !== currentDay) {
                        currentDay = item.day_number;
                        doc.moveDown();
                        // Жирный шрифт можно имитировать или загрузить Roboto-Bold.ttf
                        // Здесь просто увеличим размер и добавим подчеркивание
                        doc.fontSize(16).text(`День ${currentDay}`, { underline: true });
                        doc.moveDown(0.5);
                    }
                    doc.fontSize(12).text(`${item.time} — ${item.title} (${item.cost || 0} руб.)`);
                    if (item.notes) {
                        doc.fontSize(10).fillColor('grey').text(`   Заметка: ${item.notes}`);
                    }
                    doc.moveDown(0.5);
                    doc.fillColor('black'); // сброс цвета
                });

                doc.end();
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});