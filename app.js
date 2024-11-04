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

// Actualizar esquema de Usuario para incluir el secret TOTP
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  totpSecret: String, // Añadido para almacenar el secret TOTP
});
const User = mongoose.model('User', userSchema);

// Resto de schemas y configuración...
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

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware de autenticación actualizado para incluir verificación TOTP
async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const totpToken = req.headers['x-totp-token']; // Nuevo header para el token TOTP
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(403).json({ error: 'Token JWT requerido' });
  if (!totpToken) return res.status(403).json({ error: 'Token TOTP requerido' });

  try {
    // Verificar JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Buscar usuario y verificar TOTP
    const user = await User.findOne({ username: decoded.username });
    if (!user) return res.status(403).json({ error: 'Usuario no encontrado' });
    
    // Verificar TOTP
    const totpVerified = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: totpToken
    });

    if (!totpVerified) {
      return res.status(403).json({ error: 'Token TOTP inválido' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido o expirado' });
  }
}
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Buscar usuario por nombre de usuario
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Verificar contraseña
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(403).json({ error: 'Contraseña incorrecta' });
    }

    // Generar JWT
    const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // Si el usuario no tiene un secret TOTP, generarlo y devolver el QR
    if (!user.totpSecret) {
      const secret = speakeasy.generateSecret({ length: 20 });
      const otpauthUrl = speakeasy.otpauthURL({
        secret: secret.base32,
        label: `app:${username}`,
        issuer: 'empresa',
        encoding: 'base32'
      });

      // Guardar el secret en la base de datos
      user.totpSecret = secret.base32;
      await user.save();

      // Generar el código QR
      qrcode.toDataURL(otpauthUrl, (err, data_url) => {
        if (err) {
          return res.status(500).json({ error: 'Error generando QR' });
        }

        // Enviar el token y el QR para configurar TOTP
        res.json({
          message: 'Inicio de sesión exitoso',
          token: token,
          qrcode: data_url
        });
      });
    } else {
      // Si ya tiene TOTP configurado, solo devolver el token
      res.json({
        message: 'Inicio de sesión exitoso',
        token: token
      });
    }
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


// Endpoint actualizado para generar QR vinculado a un usuario específico
app.post('/generate-qr', async (req, res) => {
  const { username } = req.body;
  
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const secret = speakeasy.generateSecret({ length: 20 });
    const otpauthUrl = speakeasy.otpauthURL({
      secret: secret.base32,
      label: `app:${username}`,
      issuer: 'empresa',
      encoding: 'base32'
    });

    // Guardar el secret en la base de datos
    await User.updateOne(
      { username },
      { $set: { totpSecret: secret.base32 } }
    );

    qrcode.toDataURL(otpauthUrl, (err, data_url) => {
      if (err) {
        res.status(500).json({ error: 'Error generando QR' });
      } else {
        res.json({ 
          message: 'QR generado exitosamente',
          qrcode: data_url 
        });
      }
    });
  } catch (error) {
    console.error('Error al generar QR:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint de calificar empresas con autenticación TOTP
app.post('/calificarempresas', authMiddleware, async (req, res) => {
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

// Endpoint de registro actualizado para no incluir TOTP inicialmente
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ 
      username, 
      password: hashedPassword,
      totpSecret: null // Se configurará cuando el usuario genere su QR
    });
    await newUser.save();
    res.status(201).json({ 
      message: "Usuario registrado exitosamente",
      note: "Por favor, genera tu código QR TOTP usando el endpoint /generate-qr"
    });
  } catch (error) {
    console.error("Error al registrar usuario:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// Endpoint de verificación TOTP para pruebas
app.post('/verify-totp', async (req, res) => {
  const { username, token } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: token
    });

    if (verified) {
      res.json({ message: 'Token TOTP verificado correctamente' });
    } else {
      res.status(400).json({ error: 'Token TOTP inválido' });
    }
  } catch (error) {
    console.error('Error al verificar TOTP:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


app.listen(PORT, () => {
  console.log(`Servidor en funcionamiento en http://localhost:${PORT}`);
});
