import { db } from "../../db/index.js";
import CategoryController from "./category.controller.js";
import CategoryRepository from "./category.repository.js";
import CategoryService from "./category.service.js";

export function moduleCategory() {
  const categoryRepository = new CategoryRepository(db);
  const categoryService = new CategoryService(categoryRepository);
  const categoryController = new CategoryController(categoryService);

  return categoryController;
}
