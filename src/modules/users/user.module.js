import { db } from "../../db/index.js";
import UserController from "./user.controller.js";
import UserRepository from "./user.repository.js";
import UserService from "./user.service.js";
import PlanRepository from "../plans/plan.repository.js";

export function makeUserController() {
  const userRepository = new UserRepository(db);
  const planRepository = new PlanRepository(db);
  const userService = new UserService(userRepository, planRepository);
  const userController = new UserController(userService);

  return userController;
}
