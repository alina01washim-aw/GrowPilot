import mongoose from "mongoose";
import { logger } from "./logger";

let connectPromise: Promise<typeof mongoose> | null = null;

// Attach global connection event listeners ONCE at module load
mongoose.connection.on("error", (err) => {
  logger.error({ err }, "MongoDB connection error");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

mongoose.connection.on("reconnected", () => {
  logger.info("MongoDB reconnected");
});

/**
 * Lazily connects to MongoDB and reuses a single connection across the app.
 */
export function connectMongo(): Promise<typeof mongoose> {
  const uri = process.env["MONGODB_URI"];

  if (!uri) {
    throw new Error(
      "MONGODB_URI environment variable is required but was not provided.",
    );
  }

  if (!connectPromise) {
    connectPromise = mongoose
      .connect(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
      })
      .then(
      (conn) => {
        logger.info("Connected to MongoDB");
        return conn;
      },
      (err) => {
        // Clear cached promise on failure so retries can occur
        connectPromise = null;
        throw err;
      },
    );
  }

  return connectPromise;
}
