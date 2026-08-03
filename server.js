require('dotenv').config();

const fs = require('fs');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');
const cron = require('node-cron');
const { syncWmsData } = require('./sync');
const { verifySwitchStates } = require('./verification');
const { sendMismatchNotification } = require('./mailer');

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

async function resetAllToOff() {
    console.log('[CRON] Executing automated "OFF" reset for all users...');
    try {
        // End all current active sessions in the database
        await db.query(`
            UPDATE activity_logs 
            SET end_time = NOW(), 
                duration_seconds = TIMESTAMPDIFF(SECOND, start_time, NOW()) 
            WHERE end_time IS NULL
        `);

        // Broadcast to all clients to refresh UI
        broadcastUpdate({ type: 'RESET_ALL' });
        console.log('[CRON] All active sessions closed successfully.');
    } catch (err) {
        console.error('[CRON] Failed to reset all states to OFF:', err);
    }
}

/**
 * Auto-correct a user's switch state to match their last WMS scan.
 * Closes the current active session and starts a new one with the expected state.
 */
async function autoCorrectState(userId, userName, expectedState) {
    try {
        // Close current active session
        await db.query(`
            UPDATE activity_logs 
            SET end_time = NOW(), 
                duration_seconds = TIMESTAMPDIFF(SECOND, start_time, NOW()) 
            WHERE user_id = ? AND end_time IS NULL
        `, [userId]);

        // Start new session with corrected state
        await db.query(
            'INSERT INTO activity_logs (user_id, user_name, state, start_time) VALUES (?, ?, ?, NOW())',
            [userId, userName, expectedState]
        );

        // Broadcast so all clients refresh
        broadcastUpdate({ userId });
        console.log(`[AUTO-CORRECT] ${userName}: przełącznik ustawiony na "${expectedState}" (zgodnie ze skanem WMS)`);
    } catch (err) {
        console.error(`[AUTO-CORRECT] Failed to correct state for user ${userName}:`, err.message);
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
    const { name, givenName, category, excludeFromMismatchAlerts, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    try {
        await db.query('INSERT INTO users (id, name, given_name, category, exclude_from_mismatch_alerts) VALUES (?, ?, ?, ?, ?)', [id, name, givenName || null, category || null, excludeFromMismatchAlerts ? 1 : 0]);
        res.json({ id, name, givenName: givenName || null, category: category || null, exclude_from_mismatch_alerts: excludeFromMismatchAlerts ? 1 : 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: List Users with Stats
app.get('/api/users', async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT u.id, u.name, u.given_name, u.category, u.exclude_from_mismatch_alerts,
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
        
        if (!user) {
            return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
        }
        
        if (user.deleted) {
            return res.status(403).json({ error: 'Użytkownik został usunięty. Skonsultuj się z administratorem.' });
        }

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
    const { name, givenName, category, excludeFromMismatchAlerts, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }

    try {
        await db.query('UPDATE users SET name = ?, given_name = ?, category = ?, exclude_from_mismatch_alerts = ? WHERE id = ?', [name, givenName || null, category || null, excludeFromMismatchAlerts ? 1 : 0, req.params.id]);
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

// ── Config API ────────────────────────────────────────────────

// Sensitive keys that should never be exposed to the frontend
const SENSITIVE_KEYS = new Set([
    'ADMIN_PASSWORD', 'VIEW_PASSWORD',
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
    'MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_SERVER', 'MSSQL_DATABASE', 'MSSQL_PORT',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
    'PORT'
]);

// Settings that require a server restart to take effect
const RESTART_REQUIRED = new Set([
    'VERIFICATION_INTERVAL_SECONDS', 'AUTO_OFF_TIME',
    'MSSQL_SYNC_HOUR', 'MSSQL_SYNC_ENABLED',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
    'PORT'
]);

const ENV_PATH = path.join(__dirname, '.env');

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    const result = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        result[key] = val;
    }
    return result;
}

function writeEnvFile(updates) {
    let raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
    const lines = raw.split('\n');

    for (const [key, value] of Object.entries(updates)) {
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            if (trimmed.slice(0, eqIdx).trim() === key) {
                lines[i] = `${key}=${value}`;
                found = true;
                break;
            }
        }
        if (!found) {
            lines.push(`${key}=${value}`);
        }
    }

    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
    // Also update process.env so runtime checks pick up changes
    for (const [key, value] of Object.entries(updates)) {
        process.env[key] = value;
    }
}

// GET: read current config (non-sensitive keys only)
app.get('/api/config', (req, res) => {
    try {
        const all = readEnvFile();
        const safe = {};
        for (const [key, value] of Object.entries(all)) {
            if (!SENSITIVE_KEYS.has(key)) {
                safe[key] = { value, requiresRestart: RESTART_REQUIRED.has(key) };
            }
        }
        res.json(safe);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT: update config (admin password required)
app.put('/api/config', (req, res) => {
    const { password, updates } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: 'Niepoprawne hasło serwisowe' });
    }
    if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid "updates" object' });
    }

    try {
        // Reject sensitive keys
        const safeUpdates = {};
        for (const [key, value] of Object.entries(updates)) {
            if (SENSITIVE_KEYS.has(key)) {
                return res.status(400).json({ error: `Cannot modify "${key}" via API` });
            }
            safeUpdates[key] = String(value);
        }

        writeEnvFile(safeUpdates);
        console.log('[CONFIG] Updated:', Object.keys(safeUpdates).join(', '));
        res.json({ success: true, updated: Object.keys(safeUpdates) });
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

// --- State verification deduplication ---
// Track which mismatches we've already notified about to avoid spam
// Map<userId, { expectedState, currentState }>
const sentMismatches = new Map();

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startServer() {
    try {
        // 1. Initialize database (create tables, migrations)
        await db.initDB();

        // 2. Start Express server
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            
            // 3. Schedule WMS data sync
            const syncHour = process.env.MSSQL_SYNC_HOUR || 20;
            cron.schedule(`0 0 ${syncHour} * * *`, () => {
                syncWmsData().catch(err => console.error('Scheduled sync failed:', err));
            });
            console.log(`WMS sync scheduled for ${syncHour}:00 daily.`);

            // 4. Run initial sync on startup
            syncWmsData().catch(err => console.error('Initial sync failed:', err));

            // 5. Schedule state verification
            const verificationInterval = parseInt(process.env.VERIFICATION_INTERVAL_SECONDS, 10) || 30;
            cron.schedule(`*/${verificationInterval} * * * * *`, async () => {
                try {
                    const mismatches = await verifySwitchStates(verificationInterval);
                    const newMismatches = [];

                    for (const m of mismatches) {
                        const prev = sentMismatches.get(m.userId);
                        // Notify only if this is a NEW mismatch or the state CHANGED
                        if (!prev || prev.expectedState !== m.expectedState || prev.currentState !== m.currentState) {
                            newMismatches.push(m);
                            sentMismatches.set(m.userId, {
                                expectedState: m.expectedState,
                                currentState: m.currentState
                            });
                        }
                    }

                    // Remove resolved mismatches (user fixed their state)
                    const mismatchedIds = new Set(mismatches.map(m => m.userId));
                    for (const [userId] of sentMismatches) {
                        if (!mismatchedIds.has(userId)) {
                            sentMismatches.delete(userId);
                        }
                    }

                    if (newMismatches.length > 0) {
                        console.log(`[VERIFICATION] ${newMismatches.length} new/changed mismatch(es)`);
                        // Send email notification (fire-and-forget — don't block the cron tick)
                        sendMismatchNotification(newMismatches).catch(err =>
                            console.error('[VERIFICATION] Email notification failed:', err.message)
                        );

                        // Auto-correct switch states if enabled
                        if (process.env.AUTO_CORRECT_MISMATCHES === 'true') {
                            for (const m of newMismatches) {
                                autoCorrectState(m.userId, m.userName, m.expectedState).catch(err =>
                                    console.error(`[AUTO-CORRECT] Error for ${m.userName}:`, err.message)
                                );
                            }
                        }
                    }
                } catch (err) {
                    console.error('[VERIFICATION] Cron error:', err);
                }
            });
            console.log(`State verification scheduled every ${verificationInterval} seconds.`);

            // 6. Schedule automated OFF reset
            const autoOffTime = (process.env.AUTO_OFF_TIME || '23:59').trim();
            const [offHour, offMin] = autoOffTime.split(':');
            if (offHour !== undefined && offMin !== undefined) {
                cron.schedule(`0 ${offMin.trim()} ${offHour.trim()} * * *`, () => {
                    resetAllToOff().catch(err => console.error('Scheduled reset failed:', err));
                });
                console.log(`Automated OFF reset scheduled for ${autoOffTime} daily.`);
            }
        });
    } catch (err) {
        console.error('FATAL: Failed to initialize database:', err);
        process.exit(1);
    }
}

startServer();
