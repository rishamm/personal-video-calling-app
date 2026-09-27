# Deployment Guide

This guide covers deploying the personal video calling app to production.

## Quick Start - Vercel (Recommended)

Vercel is the easiest option for this app.

### Frontend Deploy (Vercel)

1. Push to GitHub if not already done.
   ```bash
   git add .
   git commit -m "Polished video app"
   git push origin main
   ```

2. Go to [vercel.com](https://vercel.com) and click "Add New → Project".
3. Import your GitHub repo.
4. Select the `personal-video-calling-app` repository.
5. In project settings:
   - Root Directory: `client`
   - Build Command: `npm run build`
   - Output Directory: `dist`
6. Add environment variable:
   - `VITE_SOCKET_SERVER=https://your-backend-url.com`
7. Click "Deploy".

### Backend Deploy (Railway or Render)

#### Option A: Railway (Recommended)

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your project repo
5. In the Variables tab, add:
   - `NODE_ENV=production`
   - `PORT=3001`
6. Click "Deploy"
7. Copy the generated URL such as `https://your-app.up.railway.app`

#### Option B: Render

1. Go to [render.com](https://render.com)
2. Click "New + → Web Service"
3. Connect your GitHub repo
4. Set values:
   - Name: `video-call-server`
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `node server/index.js`
5. Add environment variable:
   - `NODE_ENV=production`
6. Click "Create Web Service"
7. Copy the generated URL

### Connect Frontend to Backend

After the backend is running:

1. Open your Vercel project settings
2. Go to "Environment Variables"
3. Set `VITE_SOCKET_SERVER` to your backend URL
4. Redeploy the frontend

---

## Self-Hosted Deployment

### VPS Setup (DigitalOcean, AWS EC2, Linode, etc.)

#### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

#### 2. Clone and install

```bash
git clone https://github.com/yourusername/personal-video-calling-app.git
cd personal-video-calling-app
npm install
cd client
npm install
cd ..
npm run build
```

#### 3. Run with a process manager

```bash
sudo npm install -g pm2
pm2 start server/index.js --name "videocall"
pm2 startup
pm2 save
```

#### 4. Serve through Nginx

```bash
sudo apt-get install -y nginx
```

Create `/etc/nginx/sites-available/videocall`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/videocall /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### 5. Add SSL with Let's Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY server ./server
COPY client ./client

WORKDIR /app/client
RUN npm install && npm run build

WORKDIR /app

EXPOSE 3001

CMD ["npm", "start"]
```

### Build and run

```bash
docker build -t videocall .
docker run -p 3001:3001 videocall
```

---

## Environment Variables

### Server

Create `.env` in the root:

```env
NODE_ENV=production
PORT=3001
```

### Client

Create `.env` in `client/`:

```env
VITE_SOCKET_SERVER=https://your-backend-url.com
```

---

## HTTPS Requirement

WebRTC requires HTTPS in production, except for localhost.

Use:
- Vercel + automatic HTTPS
- Railway/Render + automatic HTTPS
- Let's Encrypt for self-hosted VPS

---

## Recommended Setup

For a small production app:
- Frontend: Vercel
- Backend: Railway
- Domain: custom domain

This is the easiest path and works well for a personal video app.

---

## Troubleshooting

### Camera not working
- Make sure the app is on HTTPS or localhost
- Allow browser permissions

### Connection issues
- Verify backend URL is correct
- Check the browser console
- Ensure the backend is running

### Poor call quality
- Use a better network
- Consider TURN servers in production

---

## Next Steps

1. Deploy the backend to Railway or Render
2. Deploy the frontend to Vercel
3. Set the Socket.IO URL properly
4. Test with two browser windows or devices

Good luck! 🚀
