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
    const credsPath = this.configService.get<string>('FIREBASE_CREDENTIALS_PATH') || 'firebase-service-account.json';
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
        this.logger.warn(
          `Firebase credentials file not found at ${absolutePath}. Phone Auth verification will fail unless in debug/mock.`,
        );
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

    if (!this.firebaseApp) {
      throw new Error('Firebase Admin SDK is not initialized and invalid mock token format.');
    }

    try {
      const decodedToken = await getAuth(this.firebaseApp).verifyIdToken(idToken);
      if (!decodedToken.phone_number) {
        throw new Error('Firebase ID Token is valid but does not contain a verified phone number.');
      }
      return {
        phoneNumber: decodedToken.phone_number,
        uid: decodedToken.uid,
      };
    } catch (error: any) {
      this.logger.error(`Firebase token verification failed: ${error.message}`);
      throw error;
    }
  }
}
