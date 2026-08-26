import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePostDto } from './create-post.dto';

describe('CreatePostDto', () => {
  it('accepts a description-only post', async () => {
    const dto = plainToInstance(CreatePostDto, { description: 'Hello world' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a photos-only post', async () => {
    const dto = plainToInstance(CreatePostDto, { mediaKeys: ['post-images/u1/a.jpg'] });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects more than 10 media keys', async () => {
    const dto = plainToInstance(CreatePostDto, {
      mediaKeys: Array.from({ length: 11 }, (_, i) => `post-images/u1/${i}.jpg`),
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
