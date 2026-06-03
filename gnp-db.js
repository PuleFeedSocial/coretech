const mongoose = require('mongoose');

let connected = false;

const GnpSchema = new mongoose.Schema({ key: { type: String, unique: true }, valor: mongoose.Schema.Types.Mixed });
const DataGNP = mongoose.model('DataGNP', GnpSchema);

const AsistenciaSchema = new mongoose.Schema({
  userId: String, cuartel: String, horaEntrada: String, horaSalida: String,
  h50Momento: String, fechaString: String, timestamp: { type: Date, default: Date.now }
});
const AsistenciaGNP = mongoose.model('AsistenciaGNP', AsistenciaSchema);

const H50Schema = new mongoose.Schema({
  userId: String, cuartel: String, minutos: Number, emisor: String,
  relegado: String, fechaString: String, timestamp: { type: Date, default: Date.now }
});
const H50GNP = mongoose.model('H50GNP', H50Schema);

const PerfilSchema = new mongoose.Schema({ userId: { type: String, unique: true }, ultimoAscenso: { type: Date, default: 0 } });
const PerfilGNP = mongoose.model('PerfilGNP', PerfilSchema);

const AusenciaSchema = new mongoose.Schema({ userId: { type: String, unique: true }, fechaFin: Date, motivo: String });
const AusenciaGNP = mongoose.model('AusenciaGNP', AusenciaSchema);

const LogSchema = new mongoose.Schema({
  tipo: String,
  accion: String,
  descripcion: String,
  autor: String,
  timestamp: { type: Date, default: Date.now }
});
const LogGNP = mongoose.model('LogGNP', LogSchema);

async function conectar() {
  if (connected) return;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('Variable MONGO_URI no encontrada en el entorno');
  mongoose.connection.on('error', err => console.error('[GNP] Error MongoDB:', err.message));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
  connected = true;
  crearIndices().catch(e => console.log('[GNP] Índices:', e.message));
}

async function crearIndices() {
  await Promise.all([
    DiscordUser.createIndex({ userId: 1 }),
    AsistenciaGNP.createIndex({ userId: 1, timestamp: -1 }),
    H50GNP.createIndex({ userId: 1, timestamp: -1 }),
    AusenciaGNP.createIndex({ userId: 1 }),
    PerfilGNP.createIndex({ userId: 1 }),
    LogGNP.createIndex({ timestamp: -1 })
  ]);
}

const DiscordUserSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  globalName: String,
  updatedAt: { type: Date, default: Date.now }
});
const DiscordUser = mongoose.model('DiscordUser', DiscordUserSchema);

module.exports = { conectar, DataGNP, AsistenciaGNP, H50GNP, PerfilGNP, AusenciaGNP, DiscordUser, LogGNP };
