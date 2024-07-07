import { workerData, parentPort } from 'worker_threads';
import { Poppler } from "node-poppler";

const poppler = new Poppler();

const { inputFile, outputFileName, options } = workerData;

poppler.pdfToCairo(inputFile, outputFileName, options)
  .then(() => {
    parentPort.postMessage('done');
  })
  .catch((error) => {
    throw error;
  });