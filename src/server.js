import express from 'express';
import { Poppler } from 'node-poppler';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import schedule from 'node-schedule';

const app = express();
const port = process.env.PORT || 3000;

const poppler = new Poppler();

app.post('/convert', async (req, res) => {
const pdfUrl = req.body.pdfUrl
  if (!pdfUrl) {
    return res.status(400).send('PDF URL is required');
  }

  try {
    // Download the PDF file
    const pdfPath = path.join(path.resolve(), `${Date.now()+uuidv4()}.pdf`);
    const response = await fetch(pdfUrl);
    const buffer = await response.buffer();
    await fs.writeFile(pdfPath, buffer);

    // Convert the PDF to images
    const outputDir = path.join(path.resolve(), 'output', Date.now()+uuidv4());
    await fs.mkdir(outputDir, { recursive: true });
    const outputFileName = path.join(outputDir, 'output');
    const options = {
      firstPageToConvert: 1,
      pngFile: true, 
      scalePageTo:1024
    };
    await poppler.pdfToCairo(pdfPath, outputFileName, options);

    // Create temporary links to the images
    const files = await fs.readdir(outputDir);
    const links = files.map(file => {
      const fileUrl = `${req.protocol}://${req.get('host')}/images/${path.basename(outputDir)}/${file}`;
      return fileUrl;
    });

    // Send the links as the response
    res.json({ links });

    // Schedule the deletion of the images and directories
    schedule.scheduleJob(Date.now() + 60 * 60 * 1000, async () => {
      try {
        const filesToDelete = await fs.readdir(outputDir);
        for (const file of filesToDelete) {
          await fs.unlink(path.join(outputDir, file));
        }
        await fs.rmdir(outputDir);
        console.log(`Deleted files in ${outputDir}`);
      } catch (err) {
        console.error(`Error deleting files: ${err}`);
      }
    });

    // Cleanup: Remove the downloaded PDF file
    await fs.unlink(pdfPath);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while processing the PDF');
  }
});

// Serve the images
app.use('/images', express.static(path.join(path.resolve(), 'output')));

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
