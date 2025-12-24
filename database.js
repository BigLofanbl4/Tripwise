const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./trips.db');

db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT
    )`);

    // Таблица поездок
    db.run(`CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        start_date TEXT,
        end_date TEXT,
        budget REAL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Таблица элементов поездки (точек маршрута)
    db.run(`CREATE TABLE IF NOT EXISTS trip_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER,
        day_number INTEGER,
        title TEXT,
        time TEXT,
        notes TEXT,
        cost REAL,
        category TEXT DEFAULT 'Другое',
        FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    )`);

    db.all(`PRAGMA table_info(trip_items)`, (err, columns) => {
        if (err || !Array.isArray(columns)) return;
        const hasCategory = columns.some(c => c && c.name === 'category');
        if (hasCategory) return;
        db.run(`ALTER TABLE trip_items ADD COLUMN category TEXT DEFAULT 'Другое'`, () => {
            db.run(`UPDATE trip_items SET category = 'Другое' WHERE category IS NULL`);
        });
    });

    // Таблица чек-листа вещей
    db.run(`CREATE TABLE IF NOT EXISTS packing_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER,
        title TEXT,
        is_done INTEGER DEFAULT 0,
        FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    )`);
});

module.exports = db;