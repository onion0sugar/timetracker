const sql = require('mssql');
const mysqlDB = require('./db');
require('dotenv').config();

const config = {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_SERVER,
    database: process.env.MSSQL_DATABASE,
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
        encrypt: true,
        trustServerCertificate: true,
        requestTimeout: 10000
    }
};

const DOC_TYPE_LABEL = {
    2: 'Rozkładanie',
    7: 'Zbieranie',
    8: 'Pakowanie'
};

// Map: switch state → allowed DocumentType(s).
// States absent from this map (OFF, PRZERWA, unknown) allow NO scanning.
const STATE_ALLOWED_DOC_TYPES = {
    'ZBIERANIE':   new Set([7]),
    'PAKOWANIE':   new Set([8]),
    'ROZKŁADANIE': new Set([2])
};

/**
 * Query MSSQL for recent work-type scans (Zbieranie / Pakowanie / Rozkładanie)
 * and alert on any mismatch between the user's switch state and the scanned
 * document type:
 *   - OFF / PRZERWA (or any unknown state) → no scanning allowed at all
 *   - ZBIERANIE → only DocumentType 7 allowed
 *   - PAKOWANIE → only DocumentType 8 allowed
 *   - ROZKŁADANIE → only DocumentType 2 allowed
 *
 * @param {number} lookbackSeconds - How far back to look for scans (default 30)
 */
async function verifySwitchStates(lookbackSeconds = 30) {
    if (process.env.VERIFICATION_ENABLED !== 'true') {
        console.log('[VERIFICATION] Disabled (VERIFICATION_ENABLED != true)');
        return [];
    }

    let mssqlPool;
    try {
        await mysqlDB.query('TRUNCATE TABLE verification_mismatches');

        mssqlPool = await sql.connect(config);

        // Fetch only work-type scans from today within the lookback window.
        // DocumentType IN (2=Rozkładanie, 7=Zbieranie, 8=Pakowanie)
        const query = `
            SELECT TOP 200
                   CU.UserName,
                   DD.DocumentType,
                   PPP.DateCreatedUtc
            FROM [SerwisKop_Magazyn].[Package].[PackagePositions] PPP
            JOIN Document.Documents DD ON DD.Id = PPP.DocumentId
            JOIN Core.Users        CU ON CU.Id = PPP.CreatedBy
            WHERE PPP.DateCreatedUtc >= DATEADD(SECOND, -${lookbackSeconds}, GETUTCDATE())
              AND PPP.DateCreatedUtc >= CAST(GETUTCDATE() AS DATE)
              AND DD.DocumentType IN (2, 7, 8)
            ORDER BY PPP.DateCreatedUtc DESC
        `;

        const scans = (await mssqlPool.request().query(query)).recordset;

        if (scans.length === 0) {
            console.log(`[VERIFICATION] OK: 0 scanów roboczych w oknie ${lookbackSeconds}s`);
            return [];
        }

        // Resolve unique users from MySQL once
        const uniqueUserNames = [...new Set(scans.map(s => s.UserName).filter(Boolean))];
        const userCache = {};

        for (const userName of uniqueUserNames) {
            const [users] = await mysqlDB.query(
                'SELECT id, name, given_name, exclude_from_mismatch_alerts FROM users WHERE name = ? AND deleted = 0',
                [userName]
            );
            if (users.length === 0) continue;

            const user = users[0];
            const [logs] = await mysqlDB.query(
                'SELECT state FROM activity_logs WHERE user_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1',
                [user.id]
            );

            userCache[userName] = {
                id: user.id,
                name: user.name,
                displayName: user.given_name?.trim() || user.name,
                exclude: user.exclude_from_mismatch_alerts === 1,
                currentState: logs[0]?.state ?? 'OFF'
            };
        }

        // Evaluate every scan — alert if:
        //   (a) switch is OFF/PRZERWA (no scanning allowed), OR
        //   (b) switch is active but the doc type doesn't match the allowed set
        const mismatchMap = {};
        let skippedCount = 0;

        for (const scan of scans) {
            const user = userCache[scan.UserName];
            if (!user) continue;

            const allowedTypes = STATE_ALLOWED_DOC_TYPES[user.currentState];

            // OK: state is active and the scanned doc type matches — skip
            if (allowedTypes?.has(scan.DocumentType)) continue;

            const scanLabel = DOC_TYPE_LABEL[scan.DocumentType];

            if (user.exclude) {
                skippedCount++;
                console.log(`[VERIFICATION] Niezgodność (POMINIĘTO): ${scan.UserName} skanuje ${scanLabel} przy stanie ${user.currentState}`);
                continue;
            }

            console.log(`[VERIFICATION] Niezgodność: ${scan.UserName} skanuje ${scanLabel} przy stanie ${user.currentState}`);

            if (!mismatchMap[scan.UserName]) {
                mismatchMap[scan.UserName] = {
                    userId: user.id,
                    userName: user.name,
                    displayName: user.displayName,
                    currentState: user.currentState,
                    expectedState: scanLabel,
                    lastScanTime: scan.DateCreatedUtc,
                    scanCount: 0
                };
            }
            mismatchMap[scan.UserName].scanCount++;
        }

        // Persist mismatches and build return list
        const mismatches = [];
        for (const [userName, data] of Object.entries(mismatchMap)) {
            await mysqlDB.query(
                'INSERT INTO verification_mismatches (user_name, current_state, expected_state) VALUES (?, ?, ?)',
                [userName, data.currentState, data.expectedState]
            );
            mismatches.push(data);
        }

        console.log(
            `[VERIFICATION] ${scans.length} skanów, ` +
            `${mismatches.length} niezgodności, ` +
            `${skippedCount} pominiętych (wykluczone konta)`
        );

        return mismatches;

    } catch (err) {
        console.error(`[VERIFICATION] Error: ${err.message}`);
        return [];
    } finally {
        if (mssqlPool) {
            try { await mssqlPool.close(); } catch (_) { /* ignore */ }
        }
    }
}

module.exports = { verifySwitchStates };
