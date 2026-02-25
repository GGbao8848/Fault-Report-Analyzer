import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import * as XLSX from 'xlsx';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Database
const db = new Database('reports.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    summary TEXT NOT NULL, -- JSON string of the analysis
    raw_data TEXT -- JSON string of the raw parsed data (optional, maybe too large)
  )
`);

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes

  // Get all reports
  app.get('/api/reports', (req, res) => {
    try {
      const stmt = db.prepare('SELECT id, filename, created_at, summary FROM reports ORDER BY created_at DESC');
      const reports = stmt.all();
      // Parse summary JSON for the client
      const parsedReports = reports.map((r: any) => ({
        ...r,
        summary: JSON.parse(r.summary)
      }));
      res.json(parsedReports);
    } catch (error) {
      console.error('Error fetching reports:', error);
      res.status(500).json({ error: 'Failed to fetch reports' });
    }
  });

  // Delete a report
  app.delete('/api/reports/:id', (req, res) => {
    try {
      const stmt = db.prepare('DELETE FROM reports WHERE id = ?');
      const result = stmt.run(req.params.id);
      if (result.changes > 0) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Report not found' });
      }
    } catch (error) {
      console.error('Error deleting report:', error);
      res.status(500).json({ error: 'Failed to delete report' });
    }
  });

  // Upload and process Excel file
  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      // Fix filename encoding (common issue with multer/express handling non-ASCII filenames)
      // The browser sends UTF-8, but it might be interpreted as Latin-1
      let filename = req.file.originalname;
      try {
        const decoded = Buffer.from(filename, 'latin1').toString('utf8');
        // Simple heuristic: if decoding changes it and it looks valid, use it.
        // (Actually, for this specific mojibake, we just want to force the conversion)
        filename = decoded;
      } catch (e) {
        console.warn('Filename decoding failed, using original:', e);
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      // Analysis Logic
      // Group by 'pkgs' (owner) and 'desc' (fault name)
      const analysis: Record<string, Record<string, number>> = {};

      data.forEach((row: any) => {
        const owner = row['pkgs'] ? String(row['pkgs']).trim() : 'Unknown';
        const fault = row['desc'] ? String(row['desc']).trim() : 'Unknown Fault';

        if (!analysis[owner]) {
          analysis[owner] = {};
        }
        if (!analysis[owner][fault]) {
          analysis[owner][fault] = 0;
        }
        analysis[owner][fault]++;
      });

      // Convert to array format for easier frontend consumption
      // [ { owner: 'Name', faults: [ { name: 'Fault A', count: 5 }, ... ], total: 10 } ]
      const result = Object.entries(analysis).map(([owner, faultsObj]) => {
        const faults = Object.entries(faultsObj).map(([name, count]) => ({ name, count }));
        // Sort faults by count descending
        faults.sort((a, b) => b.count - a.count);
        const total = faults.reduce((sum, f) => sum + f.count, 0);
        return { owner, faults, total };
      });

      // Sort owners by total faults descending
      result.sort((a, b) => b.total - a.total);

      // Save to DB
      const stmt = db.prepare('INSERT INTO reports (filename, summary) VALUES (?, ?)');
      const info = stmt.run(filename, JSON.stringify(result));

      res.json({
        id: info.lastInsertRowid,
        filename: filename,
        created_at: new Date().toISOString(), // Approximation for immediate return
        summary: result
      });

    } catch (error) {
      console.error('Error processing file:', error);
      res.status(500).json({ error: 'Failed to process file' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
