import {it,expect} from 'vitest';
import {DirectoryBackup,Files,S3Mount} from '@cloudflare/sandbox';
it('loads the actual installed CF SDK needed by the default owner',()=>{
 expect(typeof DirectoryBackup).toBe('function');
 expect(typeof Files).toBe('function');
 expect(typeof S3Mount).toBe('function');
});
