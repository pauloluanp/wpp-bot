import { db } from "../../db/index.js";
import FolderController from "./folder.controller.js";
import FolderRepository from "./folder.repository.js";
import FolderService from "./folder.service.js";

export function makeFolderController() {
  const folderRepository = new FolderRepository(db);
  const folderService = new FolderService(folderRepository);
  const folderController = new FolderController(folderService);

  return folderController;
}
