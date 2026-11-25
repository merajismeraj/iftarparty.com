'use strict';
const multer = require('multer');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Photos are held in memory and stored (Supabase Storage or local disk) only once the form is valid.
const images = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_TYPES.has(file.mimetype)),
});

/** Guest lists are parsed in memory; never written to disk. */
const guestList = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
});

module.exports = { images, guestList };
