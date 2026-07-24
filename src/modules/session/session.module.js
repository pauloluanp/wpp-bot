import { db } from "../../db/index.js";
import SessionRepository from "./session.repository.js";
import SessionService from "./session.service.js";
import SessionController from "./session.controller.js";
import MlCredentialRepository from "../mlCredentials/mlCredential.repository.js";
import MlCredentialService from "../mlCredentials/mlCredential.service.js";
import UserRepository from "../users/user.repository.js";
import PlanRepository from "../plans/plan.repository.js";

export function makeSessionController() {
  const repository = new SessionRepository(db);

  // Serviço de credenciais do ML, reusado para validar se a margem pode
  // converter link (exige plano premium + credenciais configuradas).
  const mlCredentialService = new MlCredentialService(
    new MlCredentialRepository(db),
    new UserRepository(db),
    new PlanRepository(db)
  );

  const service = new SessionService(repository, mlCredentialService);
  const controller = new SessionController(service);

  return controller;
}
