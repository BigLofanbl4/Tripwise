const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./trips.db');

db.serialize(() => {
    db.run(`PRAGMA foreign_keys = ON`);

    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        created_at TEXT
    )`);

    db.all(`PRAGMA table_info(users)`, (err, columns) => {
        if (err || !Array.isArray(columns)) return;
        const hasIsAdmin = columns.some(c => c && c.name === 'is_admin');
        if (hasIsAdmin) return;
        db.run(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`, () => {
            db.run(`UPDATE users SET is_admin = 0 WHERE is_admin IS NULL`);
        });
    });

    db.all(`PRAGMA table_info(users)`, (err, columns) => {
        if (err || !Array.isArray(columns)) return;
        const hasIsBanned = columns.some(c => c && c.name === 'is_banned');
        if (hasIsBanned) return;
        db.run(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`, () => {
            db.run(`UPDATE users SET is_banned = 0 WHERE is_banned IS NULL`);
        });
    });

    db.all(`PRAGMA table_info(users)`, (err, columns) => {
        if (err || !Array.isArray(columns)) return;
        const hasCreatedAt = columns.some(c => c && c.name === 'created_at');
        if (hasCreatedAt) return;
        db.run(`ALTER TABLE users ADD COLUMN created_at TEXT`, () => {
            db.run(`UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL`);
        });
    });

    // Таблица поездок
    db.run(`CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        start_date TEXT,
        end_date TEXT,
        budget REAL,
        created_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.all(`PRAGMA table_info(trips)`, (err, columns) => {
        if (err || !Array.isArray(columns)) return;
        const hasCreatedAt = columns.some(c => c && c.name === 'created_at');
        if (hasCreatedAt) return;
        db.run(`ALTER TABLE trips ADD COLUMN created_at TEXT`, () => {
            db.run(`UPDATE trips SET created_at = datetime('now') WHERE created_at IS NULL`);
        });
    });

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

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

module.exports = db;