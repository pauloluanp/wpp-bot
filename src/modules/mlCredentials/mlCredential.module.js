import { db } from "../../db/index.js";
import MlCredentialController from "./mlCredential.controller.js";
import MlCredentialRepository from "./mlCredential.repository.js";
import MlCredentialService from "./mlCredential.service.js";
import UserRepository from "../users/user.repository.js";
import PlanRepository from "../plans/plan.repository.js";

export function makeMlCredentialController() {
  const mlCredentialRepository = new MlCredentialRepository(db);
  const userRepository = new UserRepository(db);
  const planRepository = new PlanRepository(db);
  const mlCredentialService = new MlCredentialService(
    mlCredentialRepository,
    userRepository,
    planRepository
  );

  return new MlCredentialController(mlCredentialService);
}
