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
        FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    )`);
});

module.exports = db;