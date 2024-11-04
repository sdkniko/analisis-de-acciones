require('dotenv').config();
const express = require('express');
const { spawn } = require("child_process");
const OpenAI = require("openai");
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para analizar JSON
app.use(express.json());

// Configurar MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stock-analysis', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Esquema para Empresas
const empresaSchema = new mongoose.Schema({
  symbol: String,
  current_price: Number,
  RSI: Number,
  signals: [String],
  score: Number,
  analysis: String,
  dateAnalyzed: { type: Date, default: Date.now }
});
const Empresa = mongoose.model('Empresa', empresaSchema);

// Esquema para Usuarios
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
});
const User = mongoose.model('User', userSchema);

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware de autenticación
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(403).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = user;
    next();
  });
}

// Middleware para verificar TOTP
function totpMiddleware(req, res, next) {
  const { token } = req.body;

  if (!secret) {
    return res.status(400).send('Secret no definido. Generar QR primero.');
  }

  const verified = speakeasy.totp.verify({
    secret: secret.base32,
    encoding: 'base32',
    token: token
  });

  if (verified) {
    next();
  } else {
    res.status(400).send('👎🏼 Token TOTP inválido 👎🏼');
  }
}

// Protege el endpoint calificarempresas con autenticación y verificación TOTP
app.post('/calificarempresas', authMiddleware, totpMiddleware, async (req, res) => {
  const pythonProcess = spawn("python", ["main.py"]);
  let dataString = "";

  pythonProcess.stdout.on("data", (data) => {
    dataString += data.toString();
  });

  pythonProcess.stderr.on("data", (data) => {
    console.error(`Error en el script de Python:\n${data.toString()}`);
  });

  pythonProcess.on("close", async (code) => {
    if (code === 0) {
      try {
        const empresas = JSON.parse(dataString);
        const analisis = await procesarEmpresas(empresas);

        res.status(200).json({
          message: "Proceso completado exitosamente",
          analysis: analisis
        });
      } catch (error) {
        console.error("Error en el proceso:", error);
        res.status(500).json({ error: "Error al procesar las empresas" });
      }
    } else {
      console.error(`El proceso de Python finalizó con código ${code}`);
      res.status(500).json({ error: "Error al ejecutar el script de Python" });
    }
  });
});

// Endpoint de Registro
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: "Usuario registrado exitosamente" });
  } catch (error) {
    console.error("Error al registrar usuario:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// Endpoint de Login
let secret; // Variable para almacenar el secreto TOTP generado

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: "Usuario no encontrado" });

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) return res.status(401).json({ error: "Contraseña incorrecta" });

  // Verifica que JWT_SECRET esté presente
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "JWT_SECRET no está configurado en el archivo .env" });
  }

  const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // Generar el QR TOTP
  secret = speakeasy.generateSecret({ length: 20 });
  const otpauthUrl = speakeasy.otpauthURL({
    secret: secret.base32,
    label: `app:${username}`, 
    issuer: 'empresa', 
    encoding: 'base32'
  });

  qrcode.toDataURL(otpauthUrl, (err, data_url) => {
    if (err) {
      return res.status(500).json({ error: 'Error generando QR' });
    }

    res.json({ token, qrcode: data_url });
  });
});

// Endpoint para verificar TOTP
app.post('/verify-totp', (req, res) => {
  const { token } = req.body;

  if (!secret) {
    return res.status(400).send('Secret no definido. Generar QR primero.');
  }

  const verified = speakeasy.totp.verify({
    secret: secret.base32,
    encoding: 'base32',
    token: token
  });

  if (verified) {
    res.send('✅ Verificación TOTP exitosa');
  } else {
    res.status(400).send('❌ Verificación TOTP fallida');
  }
});

// Función para obtener análisis de la API de OpenAI
async function obtenerAnalisisConjunto(empresas) {
  const empresasInfo = empresas.map(emp => `
    Empresa: ${emp.symbol}
    Precio: $${emp.current_price}
    RSI: ${emp.RSI}
    Señales: ${emp.signals ? emp.signals.join(", ") : "No hay señales disponibles"}
  `).join("\n\n");

  const prompt = `
    Analiza las siguientes 10 empresas. Para cada una:
    1. Realiza un análisis fundamental breve
    2. Evalúa su potencial como oportunidad de inversión
    3. Proporciona una recomendación clara (Comprar/Mantener/Vender)
    4. Asigna un rating de 1-5 estrellas

    Empresas a analizar:
    ${empresasInfo}

    Formato deseado para cada empresa:
    SÍMBOLO:
    - Análisis fundamental:
    - Potencial de inversión:
    - Recomendación:
    - Rating: X/5 ⭐
  `;

  try {
    const response = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      prompt: prompt,
      max_tokens: 2000,
      temperature: 0.7
    });
    return response.choices[0].text;
  } catch (error) {
    console.error("Error al llamar a la API de OpenAI:", error);
    return null;
  }
}

async function procesarEmpresas(empresas) {
  try {
    const topEmpresas = empresas.sort((a, b) => b.score - a.score).slice(0, 10);
    const analisisConjunto = await obtenerAnalisisConjunto(topEmpresas);

    const promises = topEmpresas.map(async (empresa) => {
      const empresaDoc = new Empresa({
        symbol: empresa.symbol,
        current_price: empresa.current_price,
        RSI: empresa.RSI,
        signals: empresa.signals,
        score: empresa.score,
        analysis: analisisConjunto
      });

      const empresaData = empresaDoc.toObject();
      delete empresaData._id;

      await Empresa.updateOne(
        { symbol: empresa.symbol },
        { $set: empresaData },
        { upsert: true }
      );
    });

    await Promise.all(promises);
    console.log("Empresas guardadas en la base de datos exitosamente");
    return analisisConjunto;
  } catch (error) {
    console.error("Error al procesar las empresas:", error);
    throw error;
  }
}

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor en funcionamiento en http://localhost:${PORT}`);
});
