import {main} from './installer.ts';
main().catch(error=>{console.error(`OpenMA self-host: ${error.message}`);process.exitCode=1;});
