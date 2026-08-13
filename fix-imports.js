const fs = require('fs');

const files = [
  'src/modules/video-rooms/video-rooms-moderation.integration.spec.ts',
  'src/modules/video-rooms/controllers/video-rooms-roles.controller.ts',
  'src/modules/video-rooms/controllers/video-rooms-moderation.controller.spec.ts',
  'src/modules/video-rooms/controllers/video-rooms-roles.controller.spec.ts',
  'src/modules/video-rooms/services/video-room-permission.service.ts',
  'src/modules/video-rooms/services/video-room-role.service.spec.ts',
  'src/modules/video-rooms/services/video-room-member.service.ts',
  'src/modules/video-rooms/services/video-room-ownership.service.spec.ts',
  'src/modules/video-rooms/services/video-room-query.service.ts',
  'src/modules/video-rooms/services/video-room-permission.service.spec.ts',
  'src/modules/video-rooms/services/video-room-moderation-query.service.spec.ts',
  'src/modules/video-rooms/interfaces/room-actor.interface.ts',
  'src/modules/audio-rooms/services/room-permission.service.ts',
  'src/modules/audio-rooms/interfaces/room-actor.interface.ts',
  'src/modules/users/interfaces/users.service.interface.ts'
];

for (const file of files) {
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  let newLines = [];
  let addedImport = false;

  for (let line of lines) {
    if (line.includes('@prisma/client') && line.includes('PlatformRole')) {
      line = line.replace('PlatformRole, ', '')
                 .replace(', PlatformRole', '')
                 .replace('PlatformRole', '');
      
      // If the import is now empty, e.g., import { } from '@prisma/client'; or import type { }
      if (line.match(/import\s+(type\s+)?\{\s*\}\s+from\s+'@prisma\/client';/)) {
        line = '';
      }
      
      if (line !== '') newLines.push(line);
      if (!addedImport) {
        newLines.unshift("import type { PlatformRole } from 'src/common/constants';");
        addedImport = true;
      }
    } else {
      newLines.push(line);
    }
  }
  
  fs.writeFileSync(file, newLines.join('\n'));
}
