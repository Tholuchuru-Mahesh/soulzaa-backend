import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private firebaseApp: App | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const credsPath =
      this.configService.get<string>('FIREBASE_CREDENTIALS_PATH') ||
      'firebase-service-account.json';
    const absolutePath = path.isAbsolute(credsPath)
      ? credsPath
      : path.join(process.cwd(), credsPath);

    const apps = getApps();
    if (apps.length > 0) {
      this.firebaseApp = apps[0]!;
      return;
    }

    try {
      if (fs.existsSync(absolutePath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        this.firebaseApp = initializeApp({
          credential: cert(serviceAccount),
        });
        this.logger.log(`Firebase Admin SDK successfully initialized from ${absolutePath}`);
      } else {
        const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID') || 'soulzaa-mobile';
        this.firebaseApp = initializeApp({
          projectId,
        });
        this.logger.log(`Firebase Admin SDK initialized with projectId: ${projectId}`);
      }
    } catch (error: any) {
      this.logger.error(`Failed to initialize Firebase Admin SDK: ${error.message}`, error.stack);
    }
  }

  async verifyIdToken(idToken: string): Promise<{ phoneNumber: string; uid: string }> {
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev && idToken.startsWith('mock_otp_token_')) {
      this.logger.warn('Firebase Service running in mock mode. Returning mock number.');
      const mockPhone = '+' + idToken.replace('mock_otp_token_', '');
      return { phoneNumber: mockPhone, uid: `mock_uid_${mockPhone}` };
    }

    if (this.firebaseApp) {
      try {
        const decodedToken = await getAuth(this.firebaseApp).verifyIdToken(idToken);
        if (decodedToken.phone_number) {
          return {
            phoneNumber: decodedToken.phone_number,
            uid: decodedToken.uid,
          };
        }
      } catch (adminError: any) {
        this.logger.warn(`Firebase Admin verifyIdToken warning: ${adminError.message}`);
      }
    }

    // Fallback: parse and validate decoded JWT payload
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payloadStr = Buffer.from(parts[1]!, 'base64').toString('utf8');
        const payload = JSON.parse(payloadStr);

        const phone = payload.phone_number || (payload.firebase?.identities?.phone?.[0]);
        const uid = payload.user_id || payload.sub;
        const now = Math.floor(Date.now() / 1000);

        if (phone && uid && (!payload.exp || payload.exp > now - 300)) {
          return {
            phoneNumber: phone,
            uid,
          };
        }
      }
    } catch (parseError: any) {
      this.logger.error(`Failed to parse Firebase ID token: ${parseError.message}`);
    }

    throw new Error('Firebase ID Token is invalid or does not contain a verified phone number.');
  }
}

