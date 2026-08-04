"use client";

import { createProject, createProjectFromWorkflowJson } from "@/app/actions/project.actions";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

export interface CreateProjectOptions {
  template?: string;
  prompt?: string;
  router: AppRouterInstance;
  onSuccess?: (projectId: string) => void;
  onError?: (error: unknown) => void;
}

export interface CreateProjectFromJsonOptions {
  workflowJson: string;
  router: AppRouterInstance;
  onSuccess?: (projectId: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * Consolidated function to create a project with consistent error handling and navigation
 */
export async function createProjectWithOptions(options: CreateProjectOptions): Promise<void> {
  try {
    const formData = new FormData();
    
    if (options.template) {
      formData.append('template', options.template);
    }

    const response = await createProject(formData);
    
    if ('id' in response) {
      // Store prompt in localStorage if provided
      if (options.prompt?.trim()) {
        localStorage.setItem(`project_prompt_${response.id}`, options.prompt);
      }
      // If the project was created from a template (pre-built agent),
      // mark the Build step as completed in localStorage for the progress bar.
      if (options.template) {
        localStorage.setItem(`agent_instructions_changed_${response.id}`, 'true');
      }
      
      // Call success callback if provided
      if (options.onSuccess) {
        options.onSuccess(response.id);
      }
      
      // Navigate to workflow page
      options.router.push(`/projects/${response.id}/workflow`);
    } else {
      // Handle error response
      const error = response.billingError || 'Failed to create project';
      if (options.onError) {
        options.onError(error);
      } else {
        throw new Error(error);
      }
    }
  } catch (error) {
    console.error('Error creating project:', error);
    if (options.onError) {
      options.onError(error);
    } else {
      throw error;
    }
  }
}

/**
 * Consolidated function to create a project from JSON workflow
 */
export async function createProjectFromJsonWithOptions(options: CreateProjectFromJsonOptions): Promise<void> {
  try {
    const formData = new FormData();
    formData.append('workflowJson', options.workflowJson);

    const response = await createProjectFromWorkflowJson(formData);
    
    if ('id' in response) {
      // Call success callback if provided
      if (options.onSuccess) {
        options.onSuccess(response.id);
      }
      // Project created from imported JSON: mark Build step as completed
      localStorage.setItem(`agent_instructions_changed_${response.id}`, 'true');
      
      // Navigate to workflow page
      options.router.push(`/projects/${response.id}/workflow`);
    } else {
      // Handle error response
      const error = response.billingError || 'Failed to create project';
      if (options.onError) {
        options.onError(error);
      } else {
        throw new Error(error);
      }
    }
  } catch (error) {
    console.error('Error creating project from JSON:', error);
    if (options.onError) {
      options.onError(error);
    } else {
      throw error;
    }
  }
}

/**
 * Consolidated function to create a project from template selection
 */
export async function createProjectFromTemplate(
  templateId: string,
  router: AppRouterInstance,
  onError?: (error: unknown) => void
): Promise<void> {
  return createProjectWithOptions({
    template: templateId,
    router,
    onError,
  });
}
