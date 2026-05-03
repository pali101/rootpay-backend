import 'dotenv/config';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(PORT, () => {
  console.log(`RootPay backend running on port ${PORT}`);
  console.log(`Contract: ${process.env.ROOTPAY_CONTRACT_ADDRESS ?? '(not set)'}`);
});
