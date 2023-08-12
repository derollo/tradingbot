// Importera nödvändiga bibliotek
const Binance = require('binance-api-node').default;
const winston = require('winston');
require('winston-daily-rotate-file');
const nodemailer = require('nodemailer');

const INTERVAL_SECONDS = 60; // Exempelvärde, ändra enligt dina behov
let countdown = INTERVAL_SECONDS;

// ----------------------------------------------------------------------- //

// Konfigurationsobjekt
const config = {
  apiKey: process.env.API_KEY || 'hemlig',
  apiSecret: process.env.API_SECRET || 'hemlig',
  emailUser: process.env.EMAIL_USER || 'mail@gmail.com',
  emailPassword: process.env.EMAIL_PASSWORD || 'lösen',
  SYMBOL: 'DOGEBIDR',
  INTERVAL: '1m',
  SHORT_PERIOD: 2,
  LONG_PERIOD: 5,
  RISK_PERCENT: 5, // Justera detta värde för att matcha din risktolerans
  TRAILING_STOP_LOSS_PERCENT: 0.5,
  MAX_RISK_PER_TRADE_PERCENT: 2,
  DAILY_RISK_LIMIT_PERCENT: 10,
};

// ----------------------------------------------------------------------- //

// Binance setup
const binanceClient = Binance({
  apiKey: config.apiKey,
  apiSecret: config.apiSecret,
});

let openOrder = null;
let trailingStopLossPrice = null;
let dailyLoss = 0;
let dailyStartingBalance = null;
let lastTradePrice = null;

// ----------------------------------------------------------------------- //

// Winston logging setup
const transport = new winston.transports.DailyRotateFile({
  dirname: 'logs',
  filename: '%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '10d',
});

const consoleTransport = new winston.transports.Console({
  format: winston.format.simple(),
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [transport, consoleTransport],
});

logger.info('Information meddelande');
logger.warn('Varning meddelande');
logger.error('Felmeddelande');

// ----------------------------------------------------------------------- //

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: config.emailUser,
    pass: config.emailPassword,
  },
});

const sendEmailAlert = (subject, text) => {
  const mailOptions = {
    from: 'mail@gmail.com',
    to: 'mail@gmail.com',
    subject,
    text,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log('Fel vid skickande av e-post:', error);
    } else {
      console.log('E-post skickad:', info.response);
    }
  });
};

// ----------------------------------------------------------------------- //

const calculateRSI = (closes, period = 14) => {
  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const difference = closes[i] - closes[i - 1];
    gains.push(difference > 0 ? difference : 0);
    losses.push(difference < 0 ? Math.abs(difference) : 0);
  }

  const averageGain = gains.slice(-period).reduce((sum, gain) => sum + gain, 0) / period;
  const averageLoss = losses.slice(-period).reduce((sum, loss) => sum + loss, 0) / period;

  const RS = averageGain / averageLoss;
  const RSI = 100 - 100 / (1 + RS);

  return RSI;
};

const calculateStochasticOscillator = (highs, lows, closes, kPeriod = 14, dPeriod = 3) => {
  const currentClose = closes[closes.length - 1];
  const high_n = Math.max(...highs.slice(-kPeriod));
  const low_n = Math.min(...lows.slice(-kPeriod));

  const percentK = 100 * ((currentClose - low_n) / (high_n - low_n));
  const percentD = closes.slice(-dPeriod).reduce((sum, close) => sum + percentK, 0) / dPeriod;

  return { percentK, percentD };
};

// Handelslogiken
const trade = async () => {

  try {
    const accountInfo = await binanceClient.accountInfo();
    const bnbBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'BNB').free);
    logger.info(`Hämtar ljus för ${config.SYMBOL} med intervall ${config.INTERVAL}`);
    
    if (dailyStartingBalance === null) {
      dailyStartingBalance = bnbBalance;
    }

    // Kontrollera om den dagliga riskgränsen har nåtts
    dailyLoss = dailyStartingBalance - bnbBalance;
    if (dailyLoss > dailyStartingBalance * config.DAILY_RISK_LIMIT_PERCENT / 100) {
      console.log('Daglig riskgräns nådd. Stoppa handeln för dagen.');
      return;
    }

    const candles = await binanceClient.candles({
      symbol: config.SYMBOL,
      interval: config.INTERVAL,
    });

    const closes = candles.map(candle => parseFloat(candle.close));
    const highs = candles.map(candle => parseFloat(candle.high));
    const lows = candles.map(candle => parseFloat(candle.low));

    const rsi = calculateRSI(closes);
    const { percentK, percentD } = calculateStochasticOscillator(highs, lows, closes);  

    logger.info(`Hämtade ljus för ${config.SYMBOL}: ${JSON.stringify(candles)}`);

    if (candles.length === 0) {
      throw new Error('Tom svar från candles API');
    }

    const calculateMovingAverage = (data, period) => {
      return data.slice(-period).reduce((sum, candle) => sum + parseFloat(candle.close), 0) / period;
    };

    const shortMA = calculateMovingAverage(candles, config.SHORT_PERIOD);
    const longMA = calculateMovingAverage(candles, config.LONG_PERIOD);

    const latestClosePrice = parseFloat(candles[candles.length - 1].close);

    // Beräkna handelskvantiteten baserat på riskprocenten
    const tradeQuantity = (bnbBalance * config.RISK_PERCENT / 100) / latestClosePrice;
    console.log(`Handelskvantitet: ${tradeQuantity}`);

    // Beräkna den potentiella förlusten för denna handel
    const potentialLoss = tradeQuantity * latestClosePrice * config.TRAILING_STOP_LOSS_PERCENT / 100;

    // Kontrollera om den potentiella förlusten överstiger den maximala risken per handel
    if (potentialLoss > bnbBalance * config.MAX_RISK_PER_TRADE_PERCENT / 100) {
      console.log('Potentiell förlust överstiger maximal risk per handel. Hoppar över denna handel.');
      return;
    }

    if (rsi < 30 && percentK > percentD && percentK < 20 && percentD < 20) {
        if (openOrder.side === 'buy' && latestClosePrice > trailingStopLossPrice) {
          trailingStopLossPrice = latestClosePrice * (1 - config.TRAILING_STOP_LOSS_PERCENT / 100);
        } else if (openOrder.side === 'sell' && latestClosePrice < trailingStopLossPrice) {
          trailingStopLossPrice = latestClosePrice * (1 + config.TRAILING_STOP_LOSS_PERCENT / 100);
        }

        if (latestClosePrice <= trailingStopLossPrice) {
        logger.info(`Stänger öppen order på grund av trailing stop loss. Senaste pris: ${latestClosePrice}, Stop loss pris: ${trailingStopLossPrice}`);
        console.log('Stänger öppen order:', openOrder);
        await binanceClient.order({
          symbol: config.SYMBOL, // Ändrat här
          side: openOrder.side === 'buy' ? 'sell' : 'buy',
          type: 'MARKET',
          quantity: tradeQuantity,
        });
        openOrder = null;
        trailingStopLossPrice = null;
        }
        return;
    }

    if (shortMA > longMA) {
        logger.info(`Köpsignal! Utför köporder för ${config.SYMBOL} till pris ${latestClosePrice}`);
        logger.info(`Säljsignal! shortMA: ${shortMA}, longMA: ${longMA}, senaste stängningspris: ${latestClosePrice}`);
        sendEmailAlert('Köpsignal', `Köporder utförd för ${config.SYMBOL} till pris ${latestClosePrice}`);
      
        console.log('Köpsignal!');

        const order = await binanceClient.order({
          symbol: config.SYMBOL, // Ändrat här
          side: 'buy',
          type: 'MARKET',
          quantity: tradeQuantity,
        });

        logger.info(`Köporder utförd: ${JSON.stringify(order)}`);
        openOrder = { side: 'buy', price: latestClosePrice };
        trailingStopLossPrice = latestClosePrice * (1 - config.TRAILING_STOP_LOSS_PERCENT / 100);
        console.log('Köporder utförd:', order);
      } else if (rsi > 70 && percentK < percentD && percentK > 80 && percentD > 80) {
        sendEmailAlert('Säljsignal', `Säljning utförd för ${config.SYMBOL} till pris ${latestClosePrice}`);
        console.log('Säljsignal!');
        const order = await binanceClient.order({
          symbol: config.SYMBOL, // Ändrat här
          side: 'sell',
          type: 'MARKET',
          quantity: tradeQuantity,
        });
        openOrder = { side: 'sell', price: latestClosePrice };
        trailingStopLossPrice = latestClosePrice * (1 + config.TRAILING_STOP_LOSS_PERCENT / 100);
        console.log('Säljorder utförd:', order);
    }
  } catch (error) {
    logger.error('Ett fel inträffade under handeln:', error.message);
    setTimeout(trade, 5000); // Försök igen efter en fördröjning
}
};

// ----------------------------------------------------------------------- //

// Hälsokontroll
const checkHealth = async () => {
  const openOrders = await binanceClient.openOrders({ symbol: config.SYMBOL }); // Ändrat här
  try {
    // Kontrollera om det finns några ouppfyllda ordrar
    logger.info(`Hämtade öppna ordrar för ${config.SYMBOL}: ${JSON.stringify(openOrders)}`);
    if (openOrders.length > 0) {
      console.warn('Det finns ouppfyllda ordrar:', openOrders);
    }

    // Kontrollera om den dagliga riskgränsen har nåtts
    if (dailyLoss > dailyStartingBalance * config.DAILY_RISK_LIMIT_PERCENT / 100) { // Ändrat här
      console.warn('Daglig riskgräns nådd!');
    }
  } catch (error) {
      logger.error('Ett fel inträffade under hälsoövervakningen:', error.message);
  }
};

// ----------------------------------------------------------------------- //

// Kör hälsoövervakningsfunktionen var femte minut
setInterval(checkHealth, 5 * 60 * 1000);

const logProfitAndLoss = async () => {
  const accountInfo = await binanceClient.accountInfo();
  const bidrBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'BIDR').free);
  const dogeBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'DOGE').free);
  const currentProfitOrLoss = lastTradePrice ? (bidrBalance - dailyStartingBalance) * lastTradePrice : 0;

  // ANSI escape-kod för grön text
  const green = '\x1b[32m';
  // ANSI escape-kod för röd text
  const red = '\x1b[31m';
  // ANSI escape-kod för gul text
  const yellow = '\x1b[33m';
  // ANSI escape-kod för att återställa textfärgen
  const reset = '\x1b[0m';

  // Välj färg baserat på om det är vinst, förlust eller noll
  let color;
  if (currentProfitOrLoss > 0) {
    color = green;
  } else if (currentProfitOrLoss < 0) {
    color = red;
  } else {
    color = yellow;
  }

  console.log(`${color}Vinst/Förlust: ${currentProfitOrLoss.toFixed(2)} DOGE, BIDR saldo: ${bidrBalance}, DOGE saldo: ${dogeBalance}${reset}`);
};

// Logga vinst och förlust var femte minut
setInterval(logProfitAndLoss, 5 * 60 * 1000);

// Återställ daglig förlust och startbalans vid midnatt
setInterval(() => {
  dailyLoss = 0;
  dailyStartingBalance = null;
}, 24 * 60 * 60 * 1000);

// ----------------------------------------------------------------------- //

const calculateMovingAverage = (data, period) => {
  return data.slice(-period).reduce((sum, candle) => sum + parseFloat(candle.close), 0) / period;
};

// Livelogging
const liveLogging = async () => {
  const candles = await binanceClient.candles({
    symbol: config.SYMBOL,
    interval: config.INTERVAL,
  });
  try {
    if (candles.length === 0) {
      logger.warn('Ingen ljusdata (candles) tillgänglig');
      return;
    }

    // Beräkna rörliga medelvärden
    const shortMA = calculateMovingAverage(candles, config.SHORT_PERIOD); // Ändrat här
    const longMA = calculateMovingAverage(candles, config.LONG_PERIOD); // Ändrat här  
    const latestClosePrice = parseFloat(candles[candles.length - 1].close);

    // Logga informationen
    logger.info(`Liveloggning - shortMA: ${shortMA}, longMA: ${longMA}, senaste stängningspris: ${latestClosePrice}, öppen order: ${openOrder ? 'Ja' : 'Nej'}, tid kvar till nästa intervall: ${countdown} sekunder`);
} catch (error) {
  logger.error(`Ett fel inträffade under liveLogging: ${error.message}`);
}
};

// Kör liveLogging-funktionen var 10:e sekund
setInterval(liveLogging, 10000); // Kör liveLogging-funktionen var 10:e sekund

setInterval(() => {
  countdown -= 1;
  if (countdown <= 0) {
    countdown = INTERVAL_SECONDS; // Återställ räknaren till INTERVAL_SECONDS när den når 0
  }
}, 1000);
