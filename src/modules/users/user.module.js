import { db } from "../../db/index.js";
import UserController from "./user.controller.js";
import UserRepository from "./user.repository.js";
import UserService from "./user.service.js";

export function makeUserController() {
  const userRepository = new UserRepository(db);
  const userService = new UserService(userRepository);
  const userController = new UserController(userService);

  return userController;
}
