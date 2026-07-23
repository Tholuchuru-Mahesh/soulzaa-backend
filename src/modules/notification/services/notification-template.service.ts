import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface CreateTemplateInput {
  code: string;
  titleTemplate: string;
  bodyTemplate: string;
  locale?: string;
  variables?: string[];
}

@Injectable()
export class NotificationTemplateService {
  private readonly logger = new Logger(NotificationTemplateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTemplateInput): Promise<unknown> {
    const record = await this.prisma.notificationTemplate.create({
      data: {
        code: input.code,
        titleTemplate: input.titleTemplate,
        bodyTemplate: input.bodyTemplate,
        locale: input.locale ?? 'en',
        variables: (input.variables ?? []) as any,
      },
    });
    this.logger.log(`Template created: ${input.code}`);
    return record;
  }

  async findByCode(code: string): Promise<unknown> {
    return this.prisma.notificationTemplate.findUnique({
      where: { code },
    });
  }

  /**
   * Replaces placeholders like {variable} in templates with actual values from a dictionary.
   */
  render(templateStr: string, variables: Record<string, string>): string {
    let rendered = templateStr;
    for (const [key, val] of Object.entries(variables)) {
      rendered = rendered.replace(new RegExp(`{${key}}`, 'g'), val);
    }
    return rendered;
  }

  async renderTemplate(
    code: string,
    variables: Record<string, string>,
  ): Promise<{ title: string; body: string }> {
    const template: any = await this.findByCode(code);
    if (!template) {
      return { title: '', body: '' };
    }
    return {
      title: this.render(template.titleTemplate, variables),
      body: this.render(template.bodyTemplate, variables),
    };
  }
}
