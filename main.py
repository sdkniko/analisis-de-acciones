import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import ta
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import logging
import re
import json

# Configurar logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Funciones auxiliares y de limpieza de símbolos
def is_valid_symbol(symbol):
    """Verifica si un símbolo es válido"""
    invalid_patterns = [
        r'\$', r'\.W$', r'\.U$', r'\d+$', r'\.WS$', r'\.RT$', r'\.PW$', r'[A-Z]+W$', r'\.', r'[\^\$\.]'
    ]
    return isinstance(symbol, str) and not any(re.search(pattern, symbol) for pattern in invalid_patterns)

def clean_symbol(symbol):
    """Limpia y normaliza un símbolo"""
    if isinstance(symbol, str):
        symbol = symbol.strip().upper()
        return symbol if is_valid_symbol(symbol) else None
    return None

# Obtención de datos y cálculos
def get_all_tickers():
    """Obtiene símbolos válidos del mercado"""
    try:
        sp500 = pd.read_html('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies')[0]
        sp500_symbols = sp500['Symbol'].tolist()
        reliable_symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'JPM', 'V', 'WMT', 'PG', 'MA', 'HD', 'BAC', 'DIS', 'CSCO', 'VZ', 'KO']
        all_symbols = list(set(sp500_symbols + reliable_symbols))
        valid_symbols = [clean_symbol(symbol) for symbol in all_symbols if clean_symbol(symbol)]
        logger.info(f"Encontrados {len(valid_symbols)} símbolos válidos")
        return valid_symbols
    except Exception as e:
        logger.error(f"Error obteniendo símbolos: {e}")
        return []

def get_stock_data(symbol, period='3mo'):
    """Obtiene datos históricos de una acción"""
    try:
        stock = yf.Ticker(symbol)
        df = stock.history(period=period)
        if len(df) < 20 or df[['Open', 'High', 'Low', 'Close', 'Volume']].isna().sum().sum() > len(df) * 0.1:
            return None
        return df
    except Exception as e:
        logger.error(f"Error obteniendo datos para {symbol}: {e}")
        return None

def calculate_technical_indicators(df):
    """Calcula indicadores técnicos"""
    try:
        df = df.copy()
        df['RSI'] = ta.momentum.RSIIndicator(df['Close'], window=14).rsi()
        macd = ta.trend.MACD(df['Close'])
        df['MACD'] = macd.macd()
        df['MACD_Signal'] = macd.macd_signal()
        bollinger = ta.volatility.BollingerBands(df['Close'])
        df['BB_High'], df['BB_Low'] = bollinger.bollinger_hband(), bollinger.bollinger_lband()
        df['SMA_20'], df['SMA_50'] = ta.trend.sma_indicator(df['Close'], window=20), ta.trend.sma_indicator(df['Close'], window=50)
        df['Volume_SMA'] = df['Volume'].rolling(window=20).mean()
        df['Trend_20'] = (df['Close'] / df['Close'].shift(20) - 1) * 100
        return df
    except Exception as e:
        logger.error(f"Error en indicadores técnicos: {e}")
        return None

def analyze_stock(df, symbol):
    """Analiza señales técnicas"""
    if df is None or len(df) < 50:
        return None
    try:
        last_row, prev_row = df.iloc[-1], df.iloc[-2]
        signals, score = [], 0
        if 20 <= last_row['RSI'] <= 30:
            signals.append("RSI en zona de sobreventa")
            score += 3
        elif 30 < last_row['RSI'] <= 40:
            signals.append("RSI aproximándose a sobreventa")
            score += 1
        if last_row['MACD'] > last_row['MACD_Signal'] and prev_row['MACD'] <= prev_row['MACD_Signal']:
            signals.append("Cruce MACD alcista")
            score += 2
        if last_row['Close'] < last_row['BB_Low']:
            signals.append("Precio por debajo de banda inferior de Bollinger")
            score += 2
        if last_row['SMA_20'] > last_row['SMA_50'] and prev_row['SMA_20'] <= prev_row['SMA_50']:
            signals.append("Cruce alcista de medias móviles")
            score += 2
        vol_ratio = last_row['Volume'] / last_row['Volume_SMA']
        if vol_ratio > 2:
            signals.append(f"Volumen {vol_ratio:.1f}x sobre la media")
            score += 1
        if signals and score >= 2:
            return {
                'symbol': symbol,
                'signals': signals,
                'score': score,
                'current_price': last_row['Close'],
                'rsi': last_row['RSI'],
                'volume_ratio': vol_ratio,
                'trend_20d': last_row['Trend_20']
            }
    except Exception as e:
        logger.error(f"Error analizando {symbol}: {e}")
    return None

def scan_market(max_stocks=None):
    """Escanea el mercado"""
    symbols = get_all_tickers()
    symbols = symbols[:max_stocks] if max_stocks else symbols
    opportunities = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(process_stock, symbol): symbol for symbol in symbols}
        for future in as_completed(futures):
            result = future.result()
            if result:
                opportunities.append(result)
    return opportunities

def process_stock(symbol):
    df = get_stock_data(symbol)
    if df is not None:
        df = calculate_technical_indicators(df)
        return analyze_stock(df, symbol)

def main():
    opportunities = scan_market()
    opportunities.sort(key=lambda x: x['score'], reverse=True)
    # Imprimir en JSON
    print(json.dumps(opportunities, indent=4))

if __name__ == "__main__":
    main()
