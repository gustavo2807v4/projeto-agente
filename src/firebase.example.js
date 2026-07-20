import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'SUA_API_KEY_AQUI',
  authDomain: 'genesis-1d383.firebaseapp.com',
  projectId: 'genesis-1d383',
  storageBucket: 'genesis-1d383.firebasestorage.app',
  messagingSenderId: '533891117791',
  appId: '1:533891117791:web:08b2c8bb70e76a4ac16f6a'
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
