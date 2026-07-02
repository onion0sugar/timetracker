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
        requestTimeout: 10000 // 10 sekund max na zapytanie — inaczej przerwane
    }
};

// Maps DocumentType to expected switch state per LEGENDA from zapytanie.txt
function documentTypeToState(docType) {
    const map = {
        2: 'Rozkładanie',
        7: 'Zbieranie',
        8: 'Pakowanie'
    };
    // 3 and 22 are excluded at query level (NOT IN)
    // Everything else maps to "Inne"
    return map[docType] || 'Inne';
}

/**
 * Query MSSQL for recent scans and compare each user's actual activity
 * against their current switch state in activity_logs.
 *
 * @param {number} lookbackSeconds - How far back to look for scans (default 30)
 * @returns {Promise<Array<{userId, userName, displayName, currentState, expectedState, lastScanTime, scanCount}>>}
 */
async function verifySwitchStates(lookbackSeconds = 30) {
    if (process.env.VERIFICATION_ENABLED !== 'true') {
        console.log(`[VERIFICATION] Disabled (VERIFICATION_ENABLED != true)`);
        return [];
    }

    const excludeUsersStr = process.env.VERIFICATION_EXCLUDE_USERS || '';
    const excludedUsers = excludeUsersStr.split(',')
        .map(u => u.trim().toLowerCase())
        .filter(u => u.length > 0);

    let mssqlPool;
    try {
        mssqlPool = await sql.connect(config);

        const limit = 200;
        const query = `
            SELECT TOP ${limit}
                   PPP.[Id],
                   CU.UserName,
                   DD.DocumentType,
                   PPP.[DateCreatedUtc],
                   PPP.[CreatedBy]
            FROM [SerwisKop_Magazyn].[Package].[PackagePositions] PPP
            LEFT JOIN Document.Documents DD ON DD.Id = PPP.DocumentId
            LEFT JOIN Core.Users CU ON CU.Id = PPP.CreatedBy
            WHERE PPP.DateCreatedUtc >= DATEADD(SECOND, -${lookbackSeconds}, GETUTCDATE())
              AND PPP.DateCreatedUtc >= CAST(GETUTCDATE() AS DATE)
              AND DD.DocumentType NOT IN (22)
            ORDER BY PPP.DateCreatedUtc DESC
        `;

        const result = await mssqlPool.request().query(query);
        const scans = result.recordset;

        if (scans.length === 0) {
            console.log(`[VERIFICATION] OK: 0 scanów w oknie ${lookbackSeconds}s`);
            return [];
        }

        // 2. Group scans by user — each user gets the expected state
        //    based on the most recent scan in the window
        const userLatestScan = {};
        for (const scan of scans) {
            const userName = scan.UserName;
            if (!userName) continue;

            if (!userLatestScan[userName]) {
                userLatestScan[userName] = {
                    expectedState: documentTypeToState(scan.DocumentType),
                    documentType: scan.DocumentType,
                    lastScanTime: scan.DateCreatedUtc,
                    scanCount: 0
                };
            }
            userLatestScan[userName].scanCount++;
        }

        // 3. Cross-reference with MySQL activity_logs
        const mismatches = [];
        let skippedMismatchesCount = 0;
        for (const [userName, data] of Object.entries(userLatestScan)) {
            const [users] = await mysqlDB.query(
                'SELECT id, name, given_name FROM users WHERE name = ? AND deleted = 0',
                [userName]
            );

            if (users.length === 0) continue;

            const user = users[0];

            const [logs] = await mysqlDB.query(
                'SELECT state FROM activity_logs WHERE user_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1',
                [user.id]
            );

            const currentState = logs.length > 0 ? logs[0].state : 'OFF';

            // Type 3 is compatible with Rozkładanie, Zbieranie, Pakowanie
            const workStates = ['Rozkładanie', 'Zbieranie', 'Pakowanie'];
            const isType3Compatible = data.documentType === 3 && workStates.includes(currentState);

            if (currentState !== data.expectedState && !isType3Compatible) {
                const isExcluded = excludedUsers.includes(userName.toLowerCase());
                if (isExcluded) {
                    skippedMismatchesCount++;
                    console.log(`[VERIFICATION] Niezgodność (POMINIĘTO): Użytkownik ${userName} ma stan ${currentState}, a oczekiwano ${data.expectedState} (użytkownik na liście pominiętych)`);
                } else {
                    console.log(`[VERIFICATION] Niezgodność: Użytkownik ${userName} ma stan ${currentState}, a oczekiwano ${data.expectedState}`);
                    mismatches.push({
                        userId: user.id,
                        userName: user.name,
                        displayName: (user.given_name && user.given_name.trim() !== '')
                            ? user.given_name
                            : user.name,
                        currentState,
                        expectedState: data.expectedState,
                        lastScanTime: data.lastScanTime,
                        scanCount: data.scanCount
                    });
                }
            }
        }

        // 4. Log summary
        const uniqueUsers = Object.keys(userLatestScan).length;
        const consistent = uniqueUsers - mismatches.length - skippedMismatchesCount;
        console.log(
            `[VERIFICATION] OK: ${scans.length} scanów, ` +
            `${uniqueUsers} użytkowników, ` +
            `${consistent} zgodnych, ` +
            `${mismatches.length} niezgodności, ` +
            `${skippedMismatchesCount} pominiętych niezgodności`
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
