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
                given_name VARCHAR(255) DEFAULT NULL,
                category VARCHAR(50) DEFAULT NULL,
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

        await db.query(`
            CREATE TABLE IF NOT EXISTS wms_data (
                id BIGINT PRIMARY KEY,
                user_name VARCHAR(255),
                skan TEXT,
                date_created_utc DATETIME,
                date_end_utc DATETIME,
                synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration: Add category column if it doesn't exist
        const [catColumns] = await db.query('SHOW COLUMNS FROM users LIKE "category"');
        if (catColumns.length === 0) {
            await db.query('ALTER TABLE users ADD COLUMN category VARCHAR(50) DEFAULT NULL AFTER name');
            console.log('Database migrated: added "category" column to users table');
        }

        // Migration: Add deleted column if it doesn't exist
        const [columns] = await db.query('SHOW COLUMNS FROM users LIKE "deleted"');
        if (columns.length === 0) {
            await db.query('ALTER TABLE users ADD COLUMN deleted TINYINT DEFAULT 0 AFTER name');
            console.log('Database migrated: added "deleted" column to users table');
        }

        // Migration: Add given_name column if it doesn't exist
        const [gnColumns] = await db.query('SHOW COLUMNS FROM users LIKE "given_name"');
        if (gnColumns.length === 0) {
            await db.query('ALTER TABLE users ADD COLUMN given_name VARCHAR(255) DEFAULT NULL AFTER name');
            console.log('Database migrated: added "given_name" column to users table');
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


        console.log('MySQL Database initialized');
    } catch (err) {
        console.error('Error initializing MySQL:', err);
    }
}

initDB();

module.exports = db;
