import { db } from "../../db/index.js";
import SessionRepository from "./session.repository.js";
import SessionService from "./session.service.js";
import SessionController from "./session.controller.js";

export function makeSessionController() {
  const repository = new SessionRepository(db);
  const service = new SessionService(repository);
  const controller = new SessionController(service);

  return controller;
}
