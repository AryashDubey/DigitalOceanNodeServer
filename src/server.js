import express from "express";
import { Poppler } from "node-poppler";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import schedule from "node-schedule";
import { Worker } from "worker_threads";
import compression from "compression";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(compression());

const port = process.env.PORT || 8080;
const poppler = new Poppler();

const getTotalPages = (pdfInfoOutput) => {
  const pagesMatch = pdfInfoOutput.match(/Pages:\s+(\d+)/);
  return pagesMatch ? parseInt(pagesMatch[1], 10) : 0;
};

const convertPDFChunk = (inputFile, outputFileName, options) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pdfWorker.js'), {
      workerData: { inputFile, outputFileName, options }
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
};

app.post("/convert", async (req, res) => {
  console.log("Received POST request to /convert");
  const { pdfUrl, totalPages, startPage, endPage } = req.body;

  if (!pdfUrl) {
    return res.status(400).send("PDF URL is required");
  }

  const functionTime = Date.now();
  console.log(`Processing request for PDF: ${pdfUrl}`);

  try {
    // Download the PDF file
    const response = await fetch(pdfUrl);
    const buffer = await response.buffer();
    console.log(`Took ${Date.now() - functionTime}ms to download the PDF file`);

    // Save the buffer to a temporary file
    const tempDir = path.join(__dirname, "temp");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${Date.now()}.pdf`);
    await fs.writeFile(tempFile, buffer);
  

  
      const pdfInfo = await poppler.pdfInfo(tempFile);
      const actualTotalPages = getTotalPages(pdfInfo);
      const pdfText = await poppler.pdfToText(tempFile);
      const pdfDensity = pdfText.length / actualTotalPages;
      const pdfKey = crypto.createHash('sha256').update(pdfText).digest('hex');
      console.log(`PDF density: ${pdfDensity}`);
      console.log(`Total pages: ${actualTotalPages}`);
    console.log(`Took ${Date.now() - functionTime}ms to get total pages of the PDF file`);

    const firstPageToConvert = startPage || 1;
    const lastPageToConvert = endPage || actualTotalPages;

    // Convert the PDF to images
    const outputDir = path.join(__dirname, "output", Date.now() + uuidv4());
    await fs.mkdir(outputDir, { recursive: true });

    const chunkSize = 20; // Reduced chunk size
    const chunks = Math.ceil((lastPageToConvert - firstPageToConvert + 1) / chunkSize);
    const promises = Array.from({ length: chunks }, async (_, chunkIndex) => {
      const firstPage = firstPageToConvert + chunkIndex * chunkSize;
      const lastPage = Math.min(firstPage + chunkSize - 1, lastPageToConvert);
      const outputFileName = path.join(outputDir, `output_page`);
      const options = {
        firstPageToConvert: firstPage,
        lastPageToConvert: lastPage,
        pngFile: true,
        scalePageTo: actualTotalPages > 50 ? 1024 : 1536,
      };

      await convertPDFChunk(tempFile, outputFileName, options);
      console.log(`Converted pages ${firstPage} to ${lastPage} of ${actualTotalPages}`);
    });

    await Promise.all(promises);

    // Create temporary links to the images
    const files = await fs.readdir(outputDir);
    const links = files.map((file) => {
      return `${req.protocol}://${req.get("host")}/images/${path.basename(outputDir)}/${file}`;
    });

    // Sort the links
    links.sort((a, b) => {
      const aNumber = parseInt(a.match(/(\d+)/)[1]);
      const bNumber = parseInt(b.match(/(\d+)/)[1]);
      return aNumber - bNumber;
    });

    // Send the links as the response
    res.json({ links, pdfInfo:{
      totalPages: actualTotalPages,
      density: pdfDensity,
      pdfKey: pdfKey
    } });

    // Schedule the deletion of the images and directories
    schedule.scheduleJob(Date.now() + 10 * 60 * 1000, async () => {
      try {
        await fs.unlink(tempFile);
        const filesToDelete = await fs.readdir(outputDir);
        for (const file of filesToDelete) {
          await fs.unlink(path.join(outputDir, file));
        }
        await fs.rmdir(outputDir);
        console.log(`Deleted files in ${outputDir} and ${tempFile}`);
      } catch (err) {
        console.error(`Error deleting files: ${err}`);
      }
    });
  } catch (error) {
    console.error("Error processing PDF:", error);
    res.status(500).send("An error occurred while processing the PDF");
  }
});

app.post('/get-pdf-info', async (req, res) => {
  const { pdfUrl } = req.body;
  
  if (!pdfUrl) {
    return res.status(400).send("PDF URL is required");
  }

  const functionTime = Date.now();
  console.log(`Processing PDF info request for: ${pdfUrl}`);

  try {
    // Download the PDF file
    const response = await fetch(pdfUrl);
    const buffer = await response.buffer();
    console.log(`Took ${Date.now() - functionTime}ms to download the PDF file`);

    // Save the buffer to a temporary file
    const tempDir = path.join(__dirname, "temp");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${Date.now()}.pdf`);
    await fs.writeFile(tempFile, buffer);

    const pdfInfo = await poppler.pdfInfo(tempFile);
    const actualTotalPages = getTotalPages(pdfInfo);
    const pdfText = await poppler.pdfToText(tempFile);
    const pdfDensity = pdfText.length / actualTotalPages;
    const pdfKey = crypto.createHash('sha256').update(pdfText).digest('hex');

    res.json({
      totalPages: actualTotalPages,
      density: pdfDensity,
      pdfKey: pdfKey
    });

    // Schedule deletion of the temporary file
    schedule.scheduleJob(Date.now() + 10 * 60 * 1000, async () => {
      try {
        await fs.unlink(tempFile);
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`Deleted temporary file ${tempFile} and cleaned up ${tempDir}`);
      } catch (err) {
        console.error(`Error deleting files: ${err}`);
      }
    });
  } catch (error) {
    console.error("Error processing PDF info:", error);
    res.status(500).send("An error occurred while processing the PDF");
  }
});

// Serve the images
app.use("/images", express.static(path.join(__dirname, "output")));

// Add a simple GET route for testing
app.get("/", (req, res) => {
  res.send("PDF conversion service is running");
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${port}`);
});
