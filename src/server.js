import express from "express";
import { Poppler } from "node-poppler";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import schedule from "node-schedule";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

const app = express().use(express.json());
const port = process.env.PORT || 8080;

const poppler = new Poppler();

const getTotalPages = (pdfInfoOutput) => {
  const pagesMatch = pdfInfoOutput.match(/Pages:\s+(\d+)/);
  return pagesMatch ? parseInt(pagesMatch[1], 10) : 0;
};

const convertChunk = async (buffer, outputDir, firstPage, lastPage) => {
  const options = {
    firstPageToConvert: firstPage,
    lastPageToConvert: lastPage,
    pngFile: true,
    scalePageTo: 1536,
  };
  const outputFileName = path.join(outputDir, `output_page_${firstPage}-${lastPage}`);
  await poppler.pdfToCairo(buffer, outputFileName, options);
};

if (!isMainThread) {
  convertChunk(workerData.buffer, workerData.outputDir, workerData.firstPage, workerData.lastPage)
    .then(() => parentPort.postMessage("done"))
    .catch((err) => parentPort.postMessage({ error: err.message }));
}

app.post("/convert", async (req, res) => {
  const pdfUrl = req.body.pdfUrl;
  let totalPages = req.body.totalPages;
  if (!pdfUrl) {
    return res.status(400).send("PDF URL is required");
  }
  const functionTime = Date.now();
  console.log(`Received REQUEST AT ${functionTime}`);

  try {
    const response = await fetch(pdfUrl);
    const buffer = await response.buffer();

    console.log(`Took ${Date.now() - functionTime}ms to download the PDF file`);

    if (!totalPages) {
      const pdfInfo = await poppler.pdfInfo(buffer);
      totalPages = getTotalPages(pdfInfo);
      console.log(`Total pages: ${totalPages}`);
    }

    console.log(`Took ${Date.now() - functionTime}ms to get total pages of the PDF file`);

    const outputDir = path.join(path.resolve(), "output", Date.now() + uuidv4());
    await fs.mkdir(outputDir, { recursive: true });

    const chunkSize = 10; // Adjust this based on your resources
    const chunks = Math.ceil(totalPages / chunkSize);
    const workers = [];

    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
      const firstPage = chunkIndex * chunkSize + 1;
      const lastPage = Math.min(firstPage + chunkSize - 1, totalPages);
      workers.push(
        new Promise((resolve, reject) => {
          const worker = new Worker(__filename, {
            workerData: { buffer, outputDir, firstPage, lastPage },
          });
          worker.on("message", (msg) => {
            if (msg === "done") {
              resolve();
            } else {
              reject(new Error(msg.error));
            }
          });
        })
      );
    }

    await Promise.all(workers);

    const files = await fs.readdir(outputDir);
    const links = files.map((file) => {
      const fileUrl = `${req.protocol}://${req.get("host")}/images/${path.basename(outputDir)}/${file}`;
      return fileUrl;
    });

    links.sort((a, b) => {
      const aNumber = parseInt(a.match(/(\d+)/)[1]);
      const bNumber = parseInt(b.match(/(\d+)/)[1]);
      return aNumber - bNumber;
    });

    res.json({ links });

    schedule.scheduleJob(Date.now() + 10 * 60 * 1000, async () => {
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
  } catch (error) {
    console.error(error);
    res.status(500).send("An error occurred while processing the PDF");
  }
});

app.use("/images", express.static(path.join(path.resolve(), "output")));
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
