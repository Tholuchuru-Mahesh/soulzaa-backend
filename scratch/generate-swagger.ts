import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import * as fs from 'fs';

async function generateSwagger() {
  try {
    const app = await NestFactory.create(AppModule, { logger: false });
    const config = new DocumentBuilder()
      .setTitle('Soulzaa API')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    fs.writeFileSync('./scratch/swagger.json', JSON.stringify(document, null, 2));
    await app.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
generateSwagger();
