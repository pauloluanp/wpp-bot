import { db } from "../../db/index.js";
import MlConvertController from "./mlConvert.controller.js";
import MlConvertService from "./mlConvert.service.js";
import MlCredentialRepository from "../mlCredentials/mlCredential.repository.js";
import MlCredentialService from "../mlCredentials/mlCredential.service.js";
import UserRepository from "../users/user.repository.js";
import PlanRepository from "../plans/plan.repository.js";

export function makeMlConvertController() {
  const mlCredentialService = new MlCredentialService(
    new MlCredentialRepository(db),
    new UserRepository(db),
    new PlanRepository(db)
  );

  return new MlConvertController(new MlConvertService(mlCredentialService));
}

// O manager (fora do ciclo HTTP) também precisa das credenciais do dono da
// sessão; expor o service evita duplicar o acesso ao repositório lá.
export function makeMlConvertService() {
  const mlCredentialService = new MlCredentialService(
    new MlCredentialRepository(db),
    new UserRepository(db),
    new PlanRepository(db)
  );

  return new MlConvertService(mlCredentialService);
}
