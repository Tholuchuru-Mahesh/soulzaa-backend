import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/public.decorator';

@ApiTags('share-landing')
@Controller()
export class ShareRedirectController {
  @Get('r/:roomId')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Web landing page that launches the Soulzaa app for an audio room' })
  roomLanding(@Param('roomId') roomId: string): string {
    const cleanId = encodeURIComponent(roomId);
    const deepLink = `soulzaa://room/${cleanId}`;
    const intentUri = `intent://room/${cleanId}#Intent;scheme=soulzaa;package=com.soulzaa.soulzaa_mobile;end`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opening Soulzaa Room...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 36px 28px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .logo {
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 16px;
    }
    h2 { font-size: 20px; font-weight: 600; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 28px; }
    .btn {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      color: #ffffff;
      font-weight: 700;
      font-size: 16px;
      padding: 14px 20px;
      border-radius: 14px;
      text-decoration: none;
      box-shadow: 0 10px 15px -3px rgba(236, 72, 153, 0.3);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
  <script>
    function launchApp() {
      window.location.href = "${deepLink}";
      setTimeout(function() {
        if (/Android/i.test(navigator.userAgent)) {
          window.location.href = "${intentUri}";
        }
      }, 500);
    }
    window.addEventListener('DOMContentLoaded', launchApp);
  </script>
</head>
<body>
  <div class="card">
    <div class="logo">Soulzaa</div>
    <h2>Opening Room...</h2>
    <p>Opening this audio room in the Soulzaa app. If it does not open automatically, tap below.</p>
    <a class="btn" href="${deepLink}" onclick="launchApp()">Open in Soulzaa App</a>
  </div>
</body>
</html>`;
  }

  @Get('u/:username')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Web landing page that launches the Soulzaa app for a user profile' })
  userLanding(@Param('username') username: string): string {
    const cleanUser = encodeURIComponent(username);
    const deepLink = `soulzaa://user/${cleanUser}`;
    const intentUri = `intent://user/${cleanUser}#Intent;scheme=soulzaa;package=com.soulzaa.soulzaa_mobile;end`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opening Profile @${cleanUser} on Soulzaa...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 36px 28px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .logo {
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 16px;
    }
    h2 { font-size: 20px; font-weight: 600; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 28px; }
    .btn {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      color: #ffffff;
      font-weight: 700;
      font-size: 16px;
      padding: 14px 20px;
      border-radius: 14px;
      text-decoration: none;
      box-shadow: 0 10px 15px -3px rgba(236, 72, 153, 0.3);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
  <script>
    function launchApp() {
      window.location.href = "${deepLink}";
      setTimeout(function() {
        if (/Android/i.test(navigator.userAgent)) {
          window.location.href = "${intentUri}";
        }
      }, 500);
    }
    window.addEventListener('DOMContentLoaded', launchApp);
  </script>
</head>
<body>
  <div class="card">
    <div class="logo">Soulzaa</div>
    <h2>Opening Profile...</h2>
    <p>Opening @${cleanUser} in the Soulzaa app. If it does not open automatically, tap below.</p>
    <a class="btn" href="${deepLink}" onclick="launchApp()">Open in Soulzaa App</a>
  </div>
</body>
</html>`;
  }
}
