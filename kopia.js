// Binance setup
const Binance = require('binance-api-node').default;
const binanceClient = Binance({
  apiKey: 'minapi',
  apiSecret: 'minhemlighet',
});

const SYMBOL = 'SHIBDOGE';
const INTERVAL = '1m'; // Ditt valda intervall
const INTERVAL_SECONDS = parseInt(INTERVAL.slice(0, -1)) * 60; // Omvandla INTERVAL till sekunder
const LIVE_LOGGING_INTERVAL = 3000; // Intervall för liveloggning i millisekunder
let countdown = INTERVAL_SECONDS; // Initiera nedräkningen med INTERVAL_SECONDS
const SHORT_PERIOD = 3;
const LONG_PERIOD = 15;
const RISK_PERCENT = 20;
const TRAILING_STOP_LOSS_PERCENT = 1;
const MAX_RISK_PER_TRADE_PERCENT = 10;
const DAILY_RISK_LIMIT_PERCENT = 20;

let openOrder = null;
let trailingStopLossPrice = null;
let dailyLoss = 0;
let dailyStartingBalance = null;
let lastTradePrice = null;

// Winston logging
const winston = require('winston');
require('winston-daily-rotate-file');

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

//Prometheus
//const promClient = require('prom-client');
//const collectDefaultMetrics = promClient.collectDefaultMetrics;
//collectDefaultMetrics({ timeout: 5000 });

//const openOrdersGauge = new promClient.Gauge({ name: 'open_orders', help: 'Antal ouppfyllda ordrar' });
//const dailyLossGauge = new promClient.Gauge({ name: 'daily_loss', help: 'Daglig förlust i BNB' });

//const express = require('express');
//const app = express();
//const port = 9090;

//app.get('/metrics', (req, res) => {
//  res.set('Content-Type', promClient.register.contentType);
//  res.end(promClient.register.metrics());
//});

//app.listen(port, () => {
//  console.log(`Servern lyssnar på http://localhost:${port}`);
//});

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'mail@gmail.com',
    pass: 'mittlösen', // Byt ut mot ditt lösenord
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

// Handelslogiken
const trade = async () => {
    try {
      const accountInfo = await binanceClient.accountInfo();
      const bnbBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'BNB').free);
      logger.info(`Hämtar ljus för ${SYMBOL} med intervall ${INTERVAL}`);

  
      if (dailyStartingBalance === null) {
        dailyStartingBalance = bnbBalance;
      }
  
      // Kontrollera om den dagliga riskgränsen har nåtts
      dailyLoss = dailyStartingBalance - bnbBalance;
      if (dailyLoss > dailyStartingBalance * DAILY_RISK_LIMIT_PERCENT / 100) {
        console.log('Daglig riskgräns nådd. Stoppa handeln för dagen.');
        return;
      }
  
      const candles = await binanceClient.candles({
        symbol: SYMBOL,
        interval: INTERVAL,
      });
      logger.info(`Hämtade ljus för ${SYMBOL}: ${JSON.stringify(candles)}`);
  
      if (candles.length === 0) {
        throw new Error('Tom svar från candles API');
      }
  
      const calculateMovingAverage = (data, period) => {
        return data.slice(-period).reduce((sum, candle) => sum + parseFloat(candle.close), 0) / period;
      };
  
      const shortMA = calculateMovingAverage(candles, SHORT_PERIOD);
      const longMA = calculateMovingAverage(candles, LONG_PERIOD);
  
      const latestClosePrice = parseFloat(candles[candles.length - 1].close);
  
      // Beräkna handelskvantiteten baserat på riskprocenten
      const tradeQuantity = (bnbBalance * RISK_PERCENT / 100) / latestClosePrice;
      console.log(`Handelskvantitet: ${tradeQuantity}`);
  
      // Beräkna den potentiella förlusten för denna handel
      const potentialLoss = tradeQuantity * latestClosePrice * TRAILING_STOP_LOSS_PERCENT / 100;
  
      // Kontrollera om den potentiella förlusten överstiger den maximala risken per handel
      if (potentialLoss > bnbBalance * MAX_RISK_PER_TRADE_PERCENT / 100) {
        console.log('Potentiell förlust överstiger maximal risk per handel. Hoppar över denna handel.');
        return;
      }
  
      if (openOrder) {
          if (openOrder.side === 'buy' && latestClosePrice > trailingStopLossPrice) {
          trailingStopLossPrice = latestClosePrice * (1 - TRAILING_STOP_LOSS_PERCENT / 100);
          } else if (openOrder.side === 'sell' && latestClosePrice < trailingStopLossPrice) {
          trailingStopLossPrice = latestClosePrice * (1 + TRAILING_STOP_LOSS_PERCENT / 100);
          }
  
          if (latestClosePrice <= trailingStopLossPrice) {
          logger.info(`Stänger öppen order på grund av trailing stop loss. Senaste pris: ${latestClosePrice}, Stop loss pris: ${trailingStopLossPrice}`);
          console.log('Stänger öppen order:', openOrder);
          await binanceClient.order({
              symbol: SYMBOL,
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
          logger.info(`Köpsignal! Utför köporder för ${SYMBOL} till pris ${latestClosePrice}`);
          logger.info(`Säljsignal! shortMA: ${shortMA}, longMA: ${longMA}, senaste stängningspris: ${latestClosePrice}`);
          sendEmailAlert('Köpsignal', `Köporder utförd för ${SYMBOL} till pris ${latestClosePrice}`);
          console.log('Köpsignal!');
          const order = await binanceClient.order({
          symbol: SYMBOL,
          side: 'buy',
          type: 'MARKET',
          quantity: tradeQuantity,
          });
          logger.info(`Köporder utförd: ${JSON.stringify(order)}`);
          openOrder = { side: 'buy', price: latestClosePrice };
          trailingStopLossPrice = latestClosePrice * (1 - TRAILING_STOP_LOSS_PERCENT / 100);
          console.log('Köporder utförd:', order);
      } else if (shortMA < longMA) {
          sendEmailAlert('Säljsignal', `Säljning utförd för ${SYMBOL} till pris ${latestClosePrice}`);
          console.log('Säljsignal!');
          const order = await binanceClient.order({
          symbol: SYMBOL,
          side: 'sell',
          type: 'MARKET',
          quantity: tradeQuantity,
          });
          openOrder = { side: 'sell', price: latestClosePrice };
          trailingStopLossPrice = latestClosePrice * (1 + TRAILING_STOP_LOSS_PERCENT / 100);
          console.log('Säljorder utförd:', order);
      }
    } catch (error) {
        logger.error('Ett fel inträffade under handeln:', error.message);
        setTimeout(trade, 5000); // Försök igen efter en fördröjning
    }
  };
  
  const checkHealth = async () => {
    try {
      // Kontrollera om det finns några ouppfyllda ordrar
      const openOrders = await binanceClient.openOrders({ symbol: SYMBOL });
      logger.info(`Hämtade öppna ordrar för ${SYMBOL}: ${JSON.stringify(openOrders)}`);
      if (openOrders.length > 0) {
        console.warn('Det finns ouppfyllda ordrar:', openOrders);
      }
  
      // Kontrollera om den dagliga riskgränsen har nåtts
      if (dailyLoss > dailyStartingBalance * DAILY_RISK_LIMIT_PERCENT / 100) {
        console.warn('Daglig riskgräns nådd!');
      }
    } catch (error) {
        logger.error('Ett fel inträffade under hälsoövervakningen:', error.message);
    }
  };
  
  // Kör hälsoövervakningsfunktionen var femte minut
  setInterval(checkHealth, 5 * 60 * 1000);

  const logProfitAndLoss = async () => {
    const accountInfo = await binanceClient.accountInfo();
    const shibBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'SHIB').free);
    const dogeBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'DOGE').free);
    const currentProfitOrLoss = lastTradePrice ? (shibBalance - dailyStartingBalance) * lastTradePrice : 0;
  
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
  
    console.log(`${color}Vinst/Förlust: ${currentProfitOrLoss.toFixed(2)} DOGE, SHIB saldo: ${shibBalance}, DOGE saldo: ${dogeBalance}${reset}`);
  };
  
  
  
  
  // Logga vinst och förlust var femte minut
  setInterval(logProfitAndLoss, 5 * 60 * 1000);
  
  // Återställ daglig förlust och startbalans vid midnatt
setInterval(() => {
    dailyLoss = 0;
    dailyStartingBalance = null;
  }, 24 * 60 * 60 * 1000);
  
  
  const liveLogging = async () => {
    try {
      // Hämta ljusdata (candles)
      const candles = await binanceClient.candles({
        symbol: SYMBOL,
        interval: INTERVAL,
      });
  
      if (candles.length === 0) {
        logger.warn('Ingen ljusdata (candles) tillgänglig');
        return;
      }
  
      const calculateMovingAverage = (data, period) => {
        return data.slice(-period).reduce((sum, candle) => sum + parseFloat(candle.close), 0) / period;
      };
      // Beräkna rörliga medelvärden
      const shortMA = calculateMovingAverage(candles, SHORT_PERIOD);
      const longMA = calculateMovingAverage(candles, LONG_PERIOD);
      const latestClosePrice = parseFloat(candles[candles.length - 1].close);
  
      // Logga informationen
      logger.info(`Liveloggning - shortMA: ${shortMA}, longMA: ${longMA}, senaste stängningspris: ${latestClosePrice}, öppen order: ${openOrder ? 'Ja' : 'Nej'}, tid kvar till nästa intervall: ${countdown} sekunder`);
  } catch (error) {
    logger.error(`Ett fel inträffade under liveLogging: ${error.message}`);
  }
};
  
  // Kör liveLogging-funktionen var 3:e sekund
  setInterval(liveLogging, LIVE_LOGGING_INTERVAL);
  
  setInterval(() => {
    countdown -= 1;
    if (countdown <= 0) {
      countdown = INTERVAL_SECONDS; // Återställ räknaren till INTERVAL_SECONDS när den når 0
    }
  }, 1000);
  
  