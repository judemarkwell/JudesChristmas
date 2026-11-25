// Site configuration. See README.md for setup steps.

export const CONFIG = {
  siteName: 'Gift Circles',

  // Firebase web config. Safe to publish: it only identifies the project.
  // What protects the data is firestore.rules.
  firebase: {
    apiKey: 'AIzaSyCzNBJOiUh-aDU10qJbitoN8wKd3bp4bbI',
    authDomain: 'christmas-circle.firebaseapp.com',
    projectId: 'christmas-circle',
    storageBucket: 'christmas-circle.firebasestorage.app',
    messagingSenderId: '587256280183',
    appId: '1:587256280183:web:1cf18d006b1ed8c6950272',
  },

  // data/items.json is Jude's original list. Whoever signs in with this first name sees a
  // one-time "Import my starter list" button while their list is empty.
  starterListFor: 'Jude',

  // Max width/height (px) that memory photos are shrunk to before saving.
  memoryMaxSize: 1280,
};
