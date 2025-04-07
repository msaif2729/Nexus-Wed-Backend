const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Buffer } = require('buffer');
const os = require('os');
require('dotenv').config({ path: '.env.local' });


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ip = process.env.LOCAL_IP || 'localhost';
const port = process.env.PORT;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

let clients = new Map(); 

app.use(cors());
app.use('/uploads', express.static(uploadDir));
app.use(express.json({ limit: '10mb' }));

// Session Storage
const sessions = new Map(); // sessionId -> { expiresAt, files: [] }
const DEFAULT_DURATION = 10 * 60 * 1000; // 10 minutes in ms

function clearData(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    console.log("for deletion",sessions);
    console.log("Files to delete:", session);
    session.files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, err => {
          if (err) {
            console.error(`[SESSION] Error deleting file: ${file}`, err);
          } else {
            console.log(`[SESSION] Deleted file: ${file}`);
          }
        });
      }
    });
  }
  sessions.delete(sessionId);

  console.log(`[SESSION] Expired and cleaned: ${sessionId}`);

  const sessionClients = clients.get(sessionId) || [];
  sessionClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'expired' }));
      ws.close();  
    }
  });

  clients.delete(sessionId); 
}

app.post('/start-session', (req, res) => {
  const duration = (req.body.duration || 10) * 60 * 1000;
  const sessionId = uuidv4();
  const expiresAt = Date.now() + duration;

  sessions.set(sessionId, {
    expiresAt,
    files: [],
  });

  const wsUrl = `ws://${ip}:${port}`;
  const qrData = JSON.stringify({ wsUrl, sessionId });

  res.json({ sessionId, qrData });
});

app.get('/files', (req, res) => {
  const files = fs.readdirSync(uploadDir);
  res.json(files);
});

app.post('/delete-session',async (req, res) => {
  const sessionId = req.body.id;
  if (sessionId && sessions.has(sessionId)) {
    clearData(sessionId);
    return res.json({ success: true, message: 'Session deleted' });
  }
  res.status(400).json({ success: false, message: 'Invalid session ID' });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      clearData(id);
    }
  }
}, 10000);

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  let sessionId;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.type) {
        case 'init':
          sessionId = data.sessionId;
          const session = sessions.get(sessionId);
          if (!session || session.expiresAt < Date.now()) {
            ws.send(JSON.stringify({ type: 'expired' }));
            ws.close();
          } else {
            if (!clients.has(sessionId)) {
              clients.set(sessionId, []);
            }
            clients.get(sessionId).push(ws);
            ws.send(JSON.stringify({
              type:"init-ok"
            }))
          }
          break;

          case 'client-connected':
            ws.send(JSON.stringify({ type: 'ready' }));
          
            const otherClients = clients.get(sessionId) || [];
            otherClients.forEach(c => {
              if (c !== ws && c.readyState === WebSocket.OPEN) {
                c.send(JSON.stringify({ type: 'client-connected' }));
              }
            });
            break;
          

        case 'list':
          ws.send(JSON.stringify({
            type: 'list',
            files: fs.readdirSync(uploadDir),
          }));
          break;

          case 'download':
            if (!data.file) {
             console.log("no file name provided")
              return;
            }
          
            const filePath = path.join(uploadDir, data.file);
            if (fs.existsSync(filePath)) {
              const content = fs.readFileSync(filePath, { encoding: 'base64' });
              ws.send(JSON.stringify({
                type: 'file',
                name: data.file,
                content: content,
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Requested file does not exist',
              }));
            }
            break;
          

            case 'upload':
              const { name, content: base64Content } = data;
              const buffer = Buffer.from(base64Content, 'base64');
              const savePath = path.join(uploadDir, name);
              try {
                fs.writeFileSync(savePath, buffer);
                console.log(`[WS] Uploaded file: ${name}`);
            
                const session = sessions.get(sessionId);
                if (session) {
                  session.files.push(name);  
                }
            
                const fileList = fs.readdirSync(uploadDir);
                clients.forEach(sessionClients => {
                  sessionClients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) {
                      c.send(JSON.stringify({ type: 'list', files: fileList }));
                    }
                  });
                });
              } catch (error) {
                console.error(`[WS] Error uploading file: ${error}`);
                ws.send(JSON.stringify({ type: 'error', message: 'Failed to upload file' }));
              }
              break;
            

        default:
          console.warn('[WS] Unknown message type:', data.type);
      }

    } catch (error) {
      console.error('[WS] Invalid message:', error);
    }
  });

  ws.on('close', () => {
    if (sessionId && clients.has(sessionId)) {
      const updatedClients = clients.get(sessionId).filter(c => c !== ws);
      if (updatedClients.length === 0) {
        clients.delete(sessionId); 
      } else {
        clients.set(sessionId, updatedClients);
      }

      const receivers = clients.get(sessionId) || [];
      receivers.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'client-disconnected' }));
        }
      });
    }
    console.log('[WS] Client disconnected');
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Server running at http://${ip}:${PORT}`);
});
