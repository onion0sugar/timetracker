require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

// Validate required environment variables at startup
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VIEW_PASSWORD = process.env.VIEW_PASSWORD;
if (!ADMIN_PASSWORD || !VIEW_PASSWORD) {
    console.error('FATAL: ADMIN_PASSWORD and VIEW_PASSWORD must be set in .env');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// SSE: track connected dashboard clients
const sseClients = new Set();

function broadcastUpdate(data = {}) {
    for (const client of sseClients) {
        client.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

app.use(compression());
app.use(cors());
app.use(express.json());

const publicPath = path.join(__dirname, 'public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

// API: SSE endpoint for live dashboard updates
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial ping
    res.write('event: connected\ndata: {}\n\n');

    // Heartbeat every 30s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        res.write(':heartbeat\n\n');
    }, 30000);

    sseClients.add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

// API: Login (View access)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === VIEW_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Błędne hasło' });
    }
});

// API: Admin Login
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Błędne hasło' });
    }
});

// API: Create User
app.post('/api/users', async (req, res) => {
    const { name, category, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    try {
        await db.query('INSERT INTO users (id, name, category) VALUES (?, ?, ?)', [id, name, category || null]);
        res.json({ id, name, category: category || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: List Users with Stats
app.get('/api/users', async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT u.id, u.name, u.category,
                   (SELECT state FROM activity_logs WHERE user_id = u.id AND end_time IS NULL ORDER BY start_time DESC LIMIT 1) as current_state,
                   (SELECT start_time FROM activity_logs WHERE user_id = u.id AND end_time IS NULL ORDER BY start_time DESC LIMIT 1) as current_session_start
            FROM users u WHERE u.deleted = 0
        `);

        const [stats] = await db.query(`
            SELECT user_id, state, SUM(
                CASE 
                    WHEN end_time IS NOT NULL THEN duration_seconds
                    ELSE TIMESTAMPDIFF(SECOND, start_time, NOW())
                END
            ) as duration
            FROM activity_logs
            WHERE DATE(start_time) = CURDATE() AND state != 'OFF'
            GROUP BY user_id, state
        `);

        const usersWithStats = users.map(user => ({
            ...user,
            daily_stats: stats.filter(s => s.user_id === user.id)
        }));
        res.json(usersWithStats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get User Details
app.get('/api/users/:id', async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
        const user = users[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        const [logs] = await db.query('SELECT * FROM activity_logs WHERE user_id = ? ORDER BY start_time DESC LIMIT 3', [req.params.id]);
        res.json({ user, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Update State (Log Activity)
app.post('/api/logs', async (req, res) => {
    const { userId, state } = req.body;
    if (!userId || !state) return res.status(400).json({ error: 'Missing userId or state' });

    try {
        // End current active session for this user
        // Using TIMESTAMPDIFF for MySQL
        await db.query(`
            UPDATE activity_logs 
            SET end_time = NOW(), 
                duration_seconds = TIMESTAMPDIFF(SECOND, start_time, NOW()) 
            WHERE user_id = ? AND end_time IS NULL
        `, [userId]);

        // Start new session if state is not OFF
        if (state === 'OFF') {
            broadcastUpdate({ userId });
            return res.json({ success: true, state });
        }

        // Fetch user name to store it in logs
        const [users] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
        const user = users[0];

        await db.query('INSERT INTO activity_logs (user_id, user_name, state, start_time) VALUES (?, ?, ?, NOW())',
            [userId, user ? user.name : 'Unknown', state]);

        broadcastUpdate({ userId });
        res.json({ success: true, state, userName: user ? user.name : 'Unknown' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Update User (Admin Protected)
app.put('/api/users/:id', async (req, res) => {
    const { name, category, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }

    try {
        await db.query('UPDATE users SET name = ?, category = ? WHERE id = ?', [name, category || null, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Delete User (Password Protected)
app.delete('/api/users/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }

    try {
        await db.query('UPDATE users SET deleted = 1 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        sseClients: sseClients.size,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
