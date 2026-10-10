// MongoDB connection setup using Mongoose.
const mongoose = require('mongoose');
const { config } = require('./env');

async function connectDB() {
  // Surface index-build problems and validation errors clearly in development.
  mongoose.set('strictQuery', true);

  const conn = await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  return conn;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB };
