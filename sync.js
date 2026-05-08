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
        encrypt: true, // For azure, but good practice
        trustServerCertificate: true // For local/self-signed certs
    }
};

async function syncWmsData() {
    if (process.env.MSSQL_SYNC_ENABLED !== 'true') {
        console.log(`[${new Date().toISOString()}] WMS sync is disabled (MSSQL_SYNC_ENABLED != true).`);
        return;
    }

    let mssqlPool;
    try {
        console.log(`[${new Date().toISOString()}] Starting WMS data sync...`);
        
        // 1. Get the last synced ID from local database
        const [rows] = await mysqlDB.query('SELECT MAX(id) as lastId FROM wms_data');
        const lastLocalId = rows[0].lastId;
        
        // Base query with raw fields
        const selectFields = `
            PPP.Id,
            CU.UserName,
            DD.Number,
            DD.OriginalNumber,
            DD.DocumentType,
            CP.SKU,
            PPP.Quantity,
            PPP.ReceiptStillageSpaceCode,
            PPP.[DateCreatedUtc],
            DATEADD(SECOND, 1, PPP.[DateCreatedUtc]) AS DateEndUtc
        `;
        const fromJoins = `
            FROM [SerwisKop_Magazyn].[Package].[PackagePositions] PPP
            LEFT JOIN Core.Users CU ON CU.Id = PPP.CreatedBy
            LEFT JOIN Document.Documents DD ON DD.Id = PPP.DocumentId
            LEFT JOIN Catalog.Products CP ON CP.Id = PPP.ProductID
        `;

        let query;
        if (lastLocalId) {
            // Incremental sync
            query = `
                SELECT ${selectFields}
                ${fromJoins}
                WHERE PPP.Id > ${lastLocalId}
                ORDER BY PPP.Id ASC
            `;
        } else {
            // Initial sync based on retention days
            const retentionDays = parseInt(process.env.WMS_DATA_RETENTION_DAYS, 10) || 7;
            query = `
                SELECT ${selectFields}
                ${fromJoins}
                WHERE PPP.DateCreatedUtc >= DATEADD(DAY, -${retentionDays}, GETUTCDATE())
                ORDER BY PPP.Id ASC
            `;
        }

        // 2. Connect to MSSQL and fetch data
        console.log(`[${new Date().toISOString()}] Connecting to MSSQL (${config.server})...`);
        mssqlPool = await sql.connect(config);
        console.log(`[${new Date().toISOString()}] SUCCESS: Connected to MSSQL.`);
        
        const result = await mssqlPool.request().query(query);
        const data = result.recordset;

        console.log(`[${new Date().toISOString()}] Fetched ${data.length} records from MSSQL.`);

        // 3. Insert into MySQL
        if (data.length > 0) {
            let insertedCount = 0;
            for (const row of data) {
                const [insertResult] = await mysqlDB.query(
                    `INSERT IGNORE INTO wms_data (
                        id, 
                        user_name, 
                        document_number, 
                        original_number, 
                        document_type, 
                        sku, 
                        quantity, 
                        receipt_space, 
                        date_created_utc, 
                        date_end_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.Id, 
                        row.UserName, 
                        row.Number, 
                        row.OriginalNumber, 
                        row.DocumentType, 
                        row.SKU, 
                        row.Quantity, 
                        row.ReceiptStillageSpaceCode, 
                        row.DateCreatedUtc, 
                        row.DateEndUtc
                    ]
                );
                if (insertResult.affectedRows > 0) {
                    insertedCount++;
                }
            }
            console.log(`[${new Date().toISOString()}] Sync complete: ${insertedCount} new records added, ${data.length - insertedCount} skipped (already exist).`);
        } else {
            console.log(`[${new Date().toISOString()}] No new records found in MSSQL.`);
        }

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error during WMS data sync:`, err);
    } finally {
        if (mssqlPool) {
            await mssqlPool.close();
        }

        // 4. Cleanup old records based on retention days
        try {
            const retentionDays = parseInt(process.env.WMS_DATA_RETENTION_DAYS, 10);
            if (!isNaN(retentionDays) && retentionDays > 0) {
                console.log(`[${new Date().toISOString()}] Starting cleanup mechanism for WMS data older than ${retentionDays} days...`);
                const [deleteResult] = await mysqlDB.query(
                    `DELETE FROM wms_data WHERE date_created_utc < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
                    [retentionDays]
                );
                
                if (deleteResult.affectedRows > 0) {
                    console.log(`[${new Date().toISOString()}] SUCCESS: Found and deleted ${deleteResult.affectedRows} old records.`);
                } else {
                    console.log(`[${new Date().toISOString()}] No records older than ${retentionDays} days found. Nothing to delete.`);
                }
            }
        } catch (cleanupErr) {
            console.error(`[${new Date().toISOString()}] Error during WMS data cleanup:`, cleanupErr);
        }
    }
}

module.exports = { syncWmsData };
