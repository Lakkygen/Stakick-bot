import * as startCmd from './commands/core/start';
import * as helpCmd from './commands/core/help';
import * as admin from './commands/group/admin';
import * as welcome from './commands/group/welcome';
import * as weather from './commands/external/weather';
import * as crypto from './commands/external/crypto';
import * as ai from './commands/external/ai';
import * as translate from './commands/external/translate';
import * as remind from './commands/external/remind';
import * as kickCmd from './commands/kick';

export const commandRegistry = {
  start: [startCmd.start, [], 'any', 'Start the bot'],
  help: [helpCmd.help, [], 'any', 'Show help'],
  ban: [admin.ban, ['requireAdmin', 'requireGroup'], 'group', 'Ban a user'],
  unban: [admin.unban, ['requireAdmin', 'requireGroup'], 'group', 'Unban a user'],
  mute: [admin.mute, ['requireAdmin', 'requireGroup'], 'group', 'Mute a user'],
  warn: [admin.warn, ['requireAdmin', 'requireGroup'], 'group', 'Warn a user'],
  warns: [admin.listWarns, ['requireGroup'], 'group', 'List warnings'],
  purge: [admin.purge, ['requireAdmin', 'requireGroup'], 'group', 'Delete messages'],
  setwelcome: [welcome.setWelcome, ['requireAdmin', 'requireGroup'], 'group', 'Set welcome msg'],
  setrules: [welcome.setRules, ['requireAdmin', 'requireGroup'], 'group', 'Set group rules'],
  rules: [welcome.rules, ['requireGroup'], 'group', 'Show rules'],
  weather: [weather.weather, ['rateLimit'], 'any', 'Get weather'],
  crypto: [crypto.crypto, ['rateLimit'], 'any', 'Crypto prices'],
  ask: [ai.ask, ['rateLimit'], 'any', 'Ask AI'],
  translate:[translate.translate, ['rateLimit'], 'any', 'Translate text'],
  remind: [remind.remind, [], 'any', 'Set a reminder'],
  kickwatch: [kickCmd.kickWatch, ['requireGroup'], 'group', 'Watch a Kick channel'],
  kickunwatch: [kickCmd.kickUnwatch, ['requireGroup'], 'group', 'Stop watching'],
  kicklist: [kickCmd.kickList, [], 'any', 'List watched Kick channels'],
  kickstatus: [kickCmd.kickStatus, [], 'any', 'Check Kick status'],
  kickdrops: [kickCmd.kickDrops, [], 'any', 'Show drop alerts'],
  kicksetnotify:[kickCmd.kickSetNotify, ['requireAdmin', 'requireGroup'], 'group', 'Set default notify group'],
  kicklink: [kickCmd.kickLink, [], 'any', 'Link Kick OAuth'],
  kickclips: [kickCmd.kickClips, [], 'any', 'Show recent clips'],
};
