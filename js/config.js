// Site configuration. See README.md for setup steps.

export const CONFIG = {
  ownerName: 'Jude',

  // SHA-256 hash of the family code that unlocks Elf mode (lowercased, trimmed).
  // Default code is "northpole". Ask a family member to pick a new one, then run:
  //   node -e "console.log(require('crypto').createHash('sha256').update('YOURCODE').digest('hex'))"
  // and paste the result here, so you don't have to know it yourself.
  familyCodeHash: '6a2519d200ebca95532d832315500f2e1097bd1075aecf49567bd82b9b000d1c',

  // Paste your Firebase web config here to share claims and memories across devices.
  // Leave as null to run in demo mode (everything is saved only in this browser).
  // firebase: {
  //   apiKey: '...',
  //   authDomain: '...firebaseapp.com',
  //   projectId: '...',
  //   appId: '...',
  // },
  firebase: null,

  // Max width/height (px) that uploaded memory photos are shrunk to before saving.
  memoryMaxSize: 1280,
};
