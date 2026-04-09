const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'przelacznik_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();

// Initialize tables
async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                deleted TINYINT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                user_name VARCHAR(255),
                state VARCHAR(50) NOT NULL,
                start_time DATETIME NOT NULL,
                end_time DATETIME,
                duration_seconds INT,
                INDEX (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Migration: Add deleted column if it doesn't exist
        const [columns] = await db.query('SHOW COLUMNS FROM users LIKE "deleted"');
        if (columns.length === 0) {
            await db.query('ALTER TABLE users ADD COLUMN deleted TINYINT DEFAULT 0 AFTER name');
            console.log('Database migrated: added "deleted" column to users table');
        }

        // Migration: Add index on start_time for faster date filtering
        const [indexes] = await db.query(`
            SELECT INDEX_NAME FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'activity_logs'
              AND INDEX_NAME = 'idx_start_time'
        `);
        if (indexes.length === 0) {
            await db.query('ALTER TABLE activity_logs ADD INDEX idx_start_time (start_time)');
            console.log('Database migrated: added idx_start_time index on activity_logs');
        }

        // Migration: Rename 'Inne' and 'Rozkladanie' → 'Rozkładanie' in activity_logs
        const [inneLogs] = await db.query(
            `SELECT COUNT(*) AS cnt FROM activity_logs WHERE state IN ('Inne', 'Rozkladanie')`
        );
        if (inneLogs[0].cnt > 0) {
            await db.query(
                `UPDATE activity_logs SET state = 'Rozkładanie' WHERE state IN ('Inne', 'Rozkladanie')`
            );
            console.log(`Database migrated: renamed ${inneLogs[0].cnt} log(s) to 'Rozkładanie'`);
        }

        // Migration: Rename 'Inne' and 'Rozkladanie' → 'Rozkładanie' in users.current_state
        const [inneUsers] = await db.query(
            `SELECT COUNT(*) AS cnt FROM users WHERE current_state IN ('Inne', 'Rozkladanie')`
        ).catch(() => [[{ cnt: 0 }]]); // graceful fallback if column doesn't exist yet
        if (inneUsers[0].cnt > 0) {
            await db.query(
                `UPDATE users SET current_state = 'Rozkładanie' WHERE current_state IN ('Inne', 'Rozkladanie')`
            );
            console.log(`Database migrated: renamed ${inneUsers[0].cnt} user(s) current_state to 'Rozkładanie'`);
        }

        console.log('MySQL Database initialized');
    } catch (err) {
        console.error('Error initializing MySQL:', err);
    }
}

initDB();

module.exports = db;
