import { kalshiService } from './kalshiService.js';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
  // Use a random ticker to just see if it passes parameter validation
  const res = await kalshiService.placeOrder('KXBTC15M-26SEP142115-15', 'buy', 'yes', 2, 0.45);
  console.log('Result YES:', res);

  const res2 = await kalshiService.placeOrder('KXBTC15M-26SEP142115-15', 'buy', 'no', 2, 0.45);
  console.log('Result NO:', res2);
})();
