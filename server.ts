import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // API Proxy for WeChat Cloud (CloudDataManager)
  app.post("/api/cloud/:action", async (req, res) => {
    try {
      const { action } = req.params;
      const { appId, appSecret, envId, ...body } = req.body;
      
      // 1. Get access token
      const tokenResp = await axios.get(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`);
      const accessToken = tokenResp.data.access_token;
      
      if (!accessToken) throw new Error('Token failed');

      // 2. Perform action
      let targetUrl = "";
      if (action === "databasequery") {
        targetUrl = `https://api.weixin.qq.com/tcb/databasequery?access_token=${accessToken}`;
      } else if (action === "batchdownloadfile") {
        targetUrl = `https://api.weixin.qq.com/tcb/batchdownloadfile?access_token=${accessToken}`;
      }

      const response = await axios.post(targetUrl, { env: envId, ...body });
      res.json(response.data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Proxy for Laser Cutter (LaserController)
  app.post("/api/cutter/submit", async (req, res) => {
    try {
      const { remoteUrl, dxfData, params } = req.body;
      // In a real scenario, we'd send the file.
      // This is a proxy to the user's cutting IP
      const response = await axios.post(remoteUrl, { dxf: dxfData, params }, { timeout: 5000 });
      res.json(response.data);
    } catch (e: any) {
      res.status(500).json({ error: "Could not reach laser cutter at that IP" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
