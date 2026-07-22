import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Config vem de variáveis de ambiente (o Vite injeta no build): `.env.local`
// em desenvolvimento, Environment Variables na Vercel. Assim este arquivo pode
// ser versionado — sem ele no repositório, um deploy a partir do Git não
// compila. Estes valores são públicos por natureza (vão no bundle do
// cliente); quem protege os dados são as regras de segurança do Firestore.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Falha cedo e com mensagem clara: sem isso o problema só apareceria muito
// depois, no primeiro login ou sync, como um "invalid API key" sem contexto.
const missing = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(
    `Firebase não configurado (faltando: ${missing.join(', ')}). ` +
    'Copie .env.example para .env.local e preencha os valores do projeto.'
  );
}

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
