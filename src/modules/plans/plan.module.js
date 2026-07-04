import { db } from "../../db/index.js";
import PlanController from "./plan.controller.js";
import PlanRepository from "./plan.repository.js";
import PlanService from "./plan.service.js";

// Reaproveitável: expõe tanto o controller (rotas) quanto o repository
// (usado por outros módulos, como o de usuários, para o plano padrão).
export function makePlanModule() {
  const planRepository = new PlanRepository(db);
  const planService = new PlanService(planRepository);
  const planController = new PlanController(planService);

  return { planController, planService, planRepository };
}
